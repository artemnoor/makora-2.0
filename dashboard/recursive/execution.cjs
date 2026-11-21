'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { compileTicket } = require('../control.cjs');
const { assembleRun, verifyAssemblyReport } = require('../../verified-workspaces.cjs');
const { fingerprint, hashBytes, requirePlan } = require('./plan.cjs');
const { realDirectory, inside, samePath, verifyInventory, inventory, newDirectory, copyVerified,
  changesBetween, sealArtifact } = require('./artifacts.cjs');
const { createOpenCodeClient } = require('./opencode.cjs');

const WORKERS = path.resolve(__dirname, '../../workers.cjs');
const LOG_LIMIT = 256 * 1024;

function readRecord(filename) {
  const stat = fs.lstatSync(filename);
  requirePlan(stat.isFile() && stat.size <= 16 * 1024 * 1024, 'execution.evidence', 'Недопустимый файл доказательства.');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function terminate(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && process.env.SystemRoot) {
    spawnSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'],
      { shell: false, windowsHide: true, timeout: 4000, stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

function localProcess(executable, args, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false,
      windowsHide: true, detached: process.platform !== 'win32', stdio: [options.input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let timedOut = false;
    let error = null;
    let grace;
    let cancellation;
    let settled = false;
    const streams = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    for (const name of Object.keys(streams)) {
      child[name]?.on('data', (chunk) => {
        const kept = chunk.subarray(0, Math.max(0, LOG_LIMIT - sizes[name]));
        if (kept.length) streams[name].push(kept);
        sizes[name] += chunk.length;
      });
    }
    const finish = (code, signal, closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(grace);
      clearInterval(cancellation);
      resolve({
        code, signal, closed, timedOut, error,
        stdout: Buffer.concat(streams.stdout), stderr: Buffer.concat(streams.stderr),
        truncated: sizes.stdout > LOG_LIMIT || sizes.stderr > LOG_LIMIT,
      });
    };
    child.once('error', (failure) => { error = failure.message; });
    child.stdin?.on('error', (failure) => { error = failure.message; });
    if (options.input != null) child.stdin?.end(options.input);
    child.once('close', (code, signal) => finish(code, signal, true));
    const stop = () => {
      if (timedOut) return;
      timedOut = true;
      terminate(child);
      grace = setTimeout(() => finish(null, null, false), 5000);
    };
    const timeout = setTimeout(stop, Math.max(1, options.deadline - Date.now()));
    if (options.cancelled) cancellation = setInterval(() => { if (options.cancelled()) stop(); }, 250);
  });
}

function checkEnvironment(scratch) {
  const allowed = ['PATH', 'Path', 'SystemRoot', 'SystemDrive', 'ComSpec'];
  return { ...Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : [])),
    TEMP: scratch, TMP: scratch, PYTHONDONTWRITEBYTECODE: '1' };
}

function evidenceText(directory, results) {
  const lines = [];
  for (const result of results) {
    const out = fs.readFileSync(path.join(directory, result.stdout), 'utf8');
    const err = fs.readFileSync(path.join(directory, result.stderr), 'utf8');
    lines.push(JSON.stringify({ executable: result.executable, args: result.args, exit: result.exit, truncated: result.truncated }), out, err);
  }
  return lines.join('\n');
}

function stepUsage(steps) {
  const inputOutput = steps.map((step) => [step.tokens?.input, step.tokens?.output]);
  const costs = steps.map((step) => step.cost);
  return {
    tokens: steps.length && inputOutput.flat().every((value) => Number.isSafeInteger(value) && value >= 0)
      ? inputOutput.flat().reduce((sum, value) => sum + value, 0) : null,
    costMicros: steps.length && costs.every((value) => Number.isFinite(value) && value >= 0)
      ? Math.round(costs.reduce((sum, value) => sum + value, 0) * 1e6) : null,
  };
}

function workerUsage(run, worker) {
  if (worker.status !== 'completed') return {};
  try {
    const parentFile = path.join(run, worker.name + '.jsonl');
    const childFile = path.join(run, worker.name + '.export.json');
    if (!samePath(parentFile, worker.log) || !samePath(childFile, worker.exportLog) ||
      !fs.lstatSync(parentFile).isFile() || fs.statSync(parentFile).size > 16 * 1024 * 1024) return {};
    const parent = fs.readFileSync(parentFile, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
      .filter((event) => event.type === 'step_finish' && event.sessionID === worker.parentSessionID).map((event) => event.part);
    const exported = readRecord(childFile);
    const child = exported.messages.flatMap((message) => message.content ?? message.parts ?? [])
      .filter((part) => part.type === 'step-finish');
    return parent.length && child.length ? stepUsage([...parent, ...child]) : {};
  } catch { return {}; }
}

function waitingChecks(directory) {
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith('.check-start.json')) continue;
    const terminal = path.join(directory, file.replace(/\.check-start\.json$/, '.check-exit.json'));
    if (!fs.existsSync(terminal) || readRecord(terminal).closed !== true) return true;
  }
  return false;
}

function createExecution(options = {}) {
  const client = options.client ?? createOpenCodeClient();
  const runProcess = options.runProcess ?? localProcess;

  async function checks(job, input, commands) {
    verifyInventory(input.directory, input.hashes);
    const checkId = 'check-' + job.nodeId + '-' + randomUUID();
    const scratch = newDirectory(path.join(job.directory, checkId), job.directory);
    copyVerified(input.directory, scratch, input.hashes);
    const records = [];
    for (const [index, command] of commands.entries()) {
      const executable = command.executable === 'node' ? process.execPath : options.pythonPath;
      requirePlan(executable && path.isAbsolute(executable), 'execution.runtime', 'Не настроен разрешённый runtime ' + command.executable);
      requirePlan(Date.now() < job.deadline, 'execution.timeout', 'Время проверки истекло.');
      if (fs.existsSync(path.join(job.directory, 'cancel.json'))) return { status: 'failed', reason: 'Проверка отменена.', records };
      const prefix = checkId + '-' + index;
      fs.writeFileSync(path.join(job.directory, prefix + '.check-start.json'), JSON.stringify({ deadline: job.deadline }), { flag: 'wx' });
      const result = await runProcess(executable, command.args, { cwd: scratch, deadline: job.deadline, env: checkEnvironment(scratch),
        cancelled: () => fs.existsSync(path.join(job.directory, 'cancel.json')) });
      fs.writeFileSync(path.join(job.directory, prefix + '.check-exit.json'), JSON.stringify({ closed: result.closed }), { flag: 'wx' });
      fs.writeFileSync(path.join(job.directory, prefix + '.out'), result.stdout, { flag: 'wx' });
      fs.writeFileSync(path.join(job.directory, prefix + '.err'), result.stderr, { flag: 'wx' });
      records.push({ executable: command.executable, args: command.args, exit: result.code, truncated: result.truncated,
        stdout: prefix + '.out', stderr: prefix + '.err', stdoutHash: hashBytes(result.stdout), stderrHash: hashBytes(result.stderr) });
      if (!result.closed) return { status: 'unknown', reason: 'Остановка проверки не подтверждена.', records };
      if (result.code !== 0 || result.error || result.timedOut) {
        return { status: 'failed', reason: 'Не прошла проверка ' + command.executable, records };
      }
    }
    verifyInventory(input.directory, input.hashes);
    return { status: 'ok', records, verificationHash: fingerprint({ assembly: input.hashes, records }),
      testLogs: evidenceText(job.directory, records) };
  }

  function loadBatch(job) {
    const marker = readRecord(path.join(job.directory, 'managed-run.json'));
    const run = realDirectory(marker.run);
    requirePlan(inside(job.directory, run) && samePath(marker.source, job.input.directory),
      'execution.ownership', 'Не подтверждена принадлежность batch.');
    if (!fs.existsSync(path.join(run, 'summary.json'))) return null;
    const manifest = readRecord(path.join(run, 'manifest.json'));
    const summary = readRecord(path.join(run, 'summary.json'));
    requirePlan(samePath(manifest.source, job.input.directory) && samePath(summary.run, run) &&
      fingerprint(manifest.baselineHashes) === fingerprint(job.input.hashes) && summary.finishedAt,
    'execution.ownership', 'Batch использовал другой снимок.');
    return { run, manifest, summary };
  }

  async function verifyLeaf(job, saved, node, name, worker) {
    const workerDirectory = realDirectory(worker.workerPath);
    requirePlan(samePath(workerDirectory, realDirectory(saved.manifest.workers[name])) && inside(saved.run, workerDirectory) &&
      worker.model === node.model && fingerprint(worker.writeScope) === fingerprint(node.writeScope),
    'execution.ownership', 'Результат принадлежит другому исполнителю.');
    const { record } = assembleRun(saved.run, [name]);
    requirePlan(verifyAssemblyReport(record.assembly).status === 'ok', 'execution.drift', 'Сборка не прошла verify.');
    const hashes = inventory(record.assembly);
    const deltas = changesBetween(job.input.hashes, hashes);
    const verification = await checks({ ...job, nodeId: node.id }, { directory: record.assembly, hashes }, node.checks);
    if (verification.status !== 'ok') return { nodeId: node.id, ...verification };
    requirePlan(verifyAssemblyReport(record.assembly).status === 'ok', 'execution.drift', 'Сборка изменилась после проверки.');
    const artifact = sealArtifact({ directory: record.assembly, input: job.input, dependencyArtifacts: job.input.usedArtifacts,
      changes: deltas, verificationHash: verification.verificationHash, nodeId: node.id });
    const diffFile = path.join(saved.run, name + '.diff');
    requirePlan(typeof worker.diff === 'string' && samePath(diffFile, worker.diff) && fs.lstatSync(diffFile).isFile() &&
      fs.statSync(diffFile).size <= LOG_LIMIT, 'execution.evidence', 'Diff отсутствует или превышает лимит.');
    return { nodeId: node.id, status: 'ok', artifact, hashes,
      evidence: { diff: fs.readFileSync(diffFile, 'utf8'), testLogs: verification.testLogs }, sessionId: worker.childSessionID };
  }

  async function collect(job, saved) {
    const outcomes = [];
    for (const [index, node] of job.nodes.entries()) {
      const name = 'leaf-' + (index + 1);
      const checkpoint = path.join(job.directory, name + '.outcome.json');
      if (fs.existsSync(checkpoint)) {
        outcomes.push(readRecord(checkpoint));
        continue;
      }
      const worker = saved.summary.workers.find((item) => item.name === name);
      if (!worker || worker.status !== 'completed' || worker.verification?.verified !== true || worker.qualityGate?.blocked) {
        outcomes.push({ nodeId: node.id, status: 'failed', reason: worker?.reason ?? 'Исполнитель не подтверждён.' });
        continue;
      }
      try {
        const outcome = await verifyLeaf(job, saved, node, name, worker);
        if (outcome.status === 'ok') fs.writeFileSync(checkpoint, JSON.stringify(outcome), { flag: 'wx' });
        outcomes.push(outcome);
      } catch (error) {
        outcomes.push({ nodeId: node.id, status: waitingChecks(job.directory) ? 'unknown' : 'failed',
          reason: String(error.message).replace(/\s+/g, ' ').slice(0, 360) });
      }
    }
    const workers = saved.summary.workers.map((worker) => ({ sessionId: worker.childSessionID, model: worker.model,
      elapsedMs: worker.elapsedMs, ...workerUsage(saved.run, worker) }));
    const total = (key) => workers.every((worker) => Number.isSafeInteger(worker[key]))
      ? workers.reduce((sum, worker) => sum + worker[key], 0) : null;
    const unknown = outcomes.some((outcome) => outcome.status === 'unknown');
    return { status: unknown ? 'unknown' : 'done', runId: saved.run, outcomes,
      ...(unknown ? { reason: 'Завершение локальной проверки не подтверждено.' } : {}),
      usage: { tokens: total('tokens'), costMicros: total('costMicros'), workers } };
  }

  async function runBatch(job) {
    verifyInventory(job.input.directory, job.input.hashes);
    const planPath = path.join(job.directory, 'batch.json');
    let workers;
    try {
      workers = job.nodes.map((node, index) => {
        const compiled = compileTicket(node.profile, {
          goal: node.goal, context: node.context, contract: node.contract, writeScope: node.writeScope,
          criteria: node.criteria, checks: node.checks, report: 'Укажите изменённые файлы и результаты проверок.',
        });
        requirePlan(compiled.profile === node.profile && node.profile === node.model, 'execution.profile', 'Профиль модели не совпадает с утверждённым.');
        return { name: 'leaf-' + (index + 1), model: node.model, prompt: compiled.prompt, writeScope: node.writeScope };
      });
    } catch (error) { return { status: 'failed', reason: String(error.message).slice(0, 360) }; }
    fs.writeFileSync(planPath, JSON.stringify({ workspace: 'copy', workers }), { flag: 'wx' });
    const result = await runProcess(process.execPath, [WORKERS, 'batch', job.input.directory, planPath], {
      cwd: job.directory, deadline: job.deadline,
      cancelled: () => fs.existsSync(path.join(job.directory, 'cancel.json')),
      env: { ...process.env, MAKORA_BATCH_DIRECTORY: job.directory,
        OPENCODE_BATCH_BUDGET_MS: String(Math.max(1000, job.deadline - Date.now())) },
    });
    fs.writeFileSync(path.join(job.directory, 'batch.out'), result.stdout, { flag: 'wx' });
    fs.writeFileSync(path.join(job.directory, 'batch.err'), result.stderr, { flag: 'wx' });
    fs.writeFileSync(path.join(job.directory, 'batch-exit.json'), JSON.stringify({ closed: result.closed, code: result.code }), { flag: 'wx' });
    const managed = fs.existsSync(path.join(job.directory, 'managed-run.json'));
    if (result.timedOut || !result.closed) {
      const state = managed ? client.attempt(job.directory, { cancel: true }).state : null;
      return result.closed && (!managed || state === 'stopped')
        ? { status: 'failed', reason: 'Срок batch истёк. Сессии остановлены.' }
        : { status: 'unknown', reason: 'Завершение batch и его сессий не подтверждено.' };
    }
    if (!managed) return { status: 'failed', reason: 'Batch завершился до бронирования сессий.' };
    const saved = loadBatch(job);
    if (!saved) return { status: 'unknown', reason: 'Завершённый отчёт batch отсутствует.' };
    if (saved.summary.workers.some((worker) => worker.timedOut || worker.abandoned)) {
      return { status: 'unknown', reason: 'В отчёте есть сессия с неподтверждённым завершением.' };
    }
    if (client.attempt(job.directory, { allowUndispatched: true }).state !== 'stopped') {
      return { status: 'unknown', reason: 'Есть активные сессии batch.' };
    }
    verifyInventory(job.input.directory, job.input.hashes);
    return collect(job, saved);
  }

  function cancel(job) {
    const filename = path.join(job.directory, 'cancel.json');
    if (!fs.existsSync(filename)) fs.writeFileSync(filename, '{}', { flag: 'wx' });
    if (job.kind !== 'batch') return { state: waitingChecks(job.directory) ? 'unknown' : 'stopped' };
    const result = client.attempt(job.directory, { cancel: true });
    return waitingChecks(job.directory) ? { ...result, state: 'unknown' } : result;
  }

  async function recover(job) {
    const fail = (reason) => ({ status: 'failed', reason });
    if (!fs.existsSync(path.join(job.directory, 'managed-run.json'))) {
      const terminal = path.join(job.directory, 'batch-exit.json');
      return fs.existsSync(terminal) && readRecord(terminal).closed ? fail('Batch закрыт до выделения сессий.') : { status: 'unknown' };
    }
    const saved = loadBatch(job);
    const allowUndispatched = Boolean(saved && saved.summary.workers.every((worker) => !worker.abandoned && !worker.timedOut));
    if (client.attempt(job.directory, { cancel: Date.now() >= job.deadline, allowUndispatched }).state !== 'stopped') return { status: 'unknown' };
    if (!saved || saved.summary.workers.some((worker) => worker.abandoned || worker.timedOut)) {
      return fail('Сессии остановлены, проверяемый результат не сохранён.');
    }
    if (waitingChecks(job.directory)) {
      return { status: 'unknown', reason: 'Сессии остановлены. Завершение локальной проверки ещё не доказано.' };
    }
    if (Date.now() >= job.deadline) return fail('Сессии остановлены. Истёк срок проверки результата.');
    return collect(job, saved);
  }

  function canRecover(job) {
    if (!fs.existsSync(path.join(job.directory, 'managed-run.json'))) return false;
    try { return Boolean(loadBatch(job)); }
    catch { return false; }
  }

  return { runBatch, checks, cancel, recover, canRecover };
}

module.exports = { createExecution, localProcess, readRecord };
