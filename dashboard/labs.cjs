'use strict';

// Запуск демонстрационных лабораторий. Никаких оболочек, никаких агентов OpenCode.
// Разрешены только псевдонимы node/python, аргументы передаются массивом, cwd проверяется.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { ActionError, fail, makeLogger, realDirectory, samePath, isInside } = require('./store.cjs');

const DEFAULT_READY_TIMEOUT_MS = 10000;
const DEFAULT_CONNECT_TIMEOUT_MS = 500;
const DEFAULT_STOP_GRACE_MS = 3000;
const LOG_LIMIT = 32768;

function defaultRunRoot() {
  if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Codex', 'OpenCode workers');
  return path.join(os.homedir(), '.local', 'share', 'opencode-workers');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function allocatePort(netLike = net) {
  return new Promise((resolve, reject) => {
    const server = netLike.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function tryConnect(port, netLike = net, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const socket = netLike.connect({ host: '127.0.0.1', port });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Передаём демо минимум переменных: никаких токенов и учётных данных из окружения.
function childEnvironment(port, dataDir, options = {}) {
  const env = {
    PATH: process.env.PATH || process.env.Path || '',
    PORT: String(port),
    DATA_DIR: dataDir,
    TEMP: process.env.TEMP || os.tmpdir(),
    TMP: process.env.TMP || os.tmpdir(),
    PYTHONUNBUFFERED: '1',
  };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'USERPROFILE', 'ComSpec']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, ...(options.extraEnv || {}) };
}

class LabRunner {
  constructor(options = {}) {
    this.options = options;
    this.log = makeLogger(options);
    this.fs = options.fs || fs;
    this.net = options.net || net;
    this.spawnFn = options.spawn || spawn;
    this.spawnSyncFn = options.spawnSync || spawnSync;
    this.sleepFn = options.sleep || sleep;
    this.allocatePortFn = options.allocatePort || (() => allocatePort(this.net));
    this.dataDir = path.resolve(options.dataDir || path.join(__dirname, 'data'));
    this.runRoot = path.resolve(options.runRoot || defaultRunRoot());
    this.readyTimeoutMs = Number.isFinite(options.readyTimeoutMs) ? options.readyTimeoutMs : DEFAULT_READY_TIMEOUT_MS;
    this.connectTimeoutMs = Number.isFinite(options.connectTimeoutMs) ? options.connectTimeoutMs : DEFAULT_CONNECT_TIMEOUT_MS;
    this.stopGraceMs = Number.isFinite(options.stopGraceMs) ? options.stopGraceMs : DEFAULT_STOP_GRACE_MS;
    this.executables = {
      node: process.execPath,
      python: 'python',
      ...(options.executables || {}),
    };
    this.processes = new Map(); // labId -> owned record
    this.starting = new Set();
    this.labDirs = new Map(); // labId -> созданные нами каталоги данных
    this.fs.mkdirSync(this.dataDir, { recursive: true });
  }

  // cwd должен быть внутри канонического проекта или проверенного worktree этого проекта.
  validateCwd(projectPath, cwd, projectId = null) {
    if (typeof cwd !== 'string' || !cwd.trim()) {
      fail('Укажите cwd демонстрации.', 'lab.cwd_required', { field: 'cwd' });
    }
    const canonical = realDirectory(cwd, 'cwd');
    if (isInside(this.dataDir, canonical) || isInside(path.resolve(__dirname), canonical)) {
      fail('Нельзя запускать демонстрацию из каталога панели или её данных.', 'lab.cwd_reserved', { cwd: canonical });
    }
    const project = realDirectory(projectPath, 'каталог проекта');
    if (isInside(project, canonical)) return canonical;
    if (this.options.verifyWorktree) {
      const verified = this.options.verifyWorktree({ projectPath: project, cwd: canonical, runRoot: this.runRoot, projectId });
      if (verified) return canonical;
    } else if (this.verifyWorktreeWithGit(project, canonical)) {
      return canonical;
    }
    fail(`cwd должен находиться внутри зарегистрированного проекта (${project}) или в проверенном run-worktree этого проекта (${this.runRoot}).`,
      'lab.cwd_outside', { cwd: canonical, projectPath: project, runRoot: this.runRoot });
  }

  verifyWorktreeWithGit(projectPath, cwd) {
    if (!isInside(this.runRoot, cwd) || samePath(this.runRoot, cwd)) return false;
    const top = this.gitOutput(cwd, ['rev-parse', '--show-toplevel']);
    if (!top) return false;
    const topPath = path.resolve(top.trim());
    if (!isInside(this.runRoot, topPath) || samePath(this.runRoot, topPath)) return false;
    let common = this.gitOutput(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']) ||
      this.gitOutput(cwd, ['rev-parse', '--git-common-dir']);
    if (!common) return false;
    common = common.trim();
    if (!path.isAbsolute(common)) common = path.resolve(cwd, common);
    const expected = path.resolve(projectPath, '.git');
    return samePath(common, expected) || samePath(common, projectPath);
  }

  gitOutput(cwd, args) {
    let result;
    try {
      result = this.spawnSyncFn('git', ['-C', cwd, ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false, maxBuffer: 1024 * 1024,
      });
    } catch {
      return null;
    }
    if (!result || result.status !== 0 || !result.stdout) return null;
    return String(result.stdout);
  }

  resolveExecutable(runtime) {
    const executable = this.executables[runtime];
    if (!executable || typeof executable !== 'string') {
      fail(`Для runtime «${runtime}» не настроен исполняемый файл. Разрешены только node и python.`, 'lab.runtime_unavailable', { runtime });
    }
    return executable;
  }

  async start({ labId, config }) {
    if (!labId) fail('Не указана лаборатория.', 'lab.required');
    if (this.starting.has(labId)) fail('Запуск лаборатории уже выполняется.', 'lab.start_in_progress', { id: labId });
    if (this.processes.has(labId)) {
      fail('Демо уже запущен этим сервером. Остановите его командой lab.stop.', 'lab.already_running', { id: labId });
    }
    this.starting.add(labId);
    let dataDir = null;
    let port = null;
    let record = null;
    try {
      if (!config || !['node', 'python'].includes(config.runtime)) {
        fail('Демо должно быть настроено с runtime node или python.', 'lab.not_configured', { id: labId });
      }
      const args = Array.isArray(config.args) ? config.args : [];
      if (!args.length || args.some((arg) => typeof arg !== 'string')) {
        fail('Аргументы демонстрации должны быть непустым массивом строк.', 'lab.args_invalid', { id: labId });
      }
      const executable = this.resolveExecutable(config.runtime);
      port = await this.allocatePortFn();
      if (!Number.isInteger(port) || port < 1 || port > 65535) fail('Не удалось выделить порт для демо.', 'lab.port_failed', { id: labId });
      const safeId = String(labId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'lab';
      dataDir = this.fs.mkdtempSync(path.join(this.dataDir, `${safeId}-`));
      this.labDirs.set(labId, dataDir);
      const usesPort = args.some((arg) => arg.includes('{port}'));
      const expanded = args.map((arg) => String(arg).replaceAll('{port}', String(port)).replaceAll('{data}', dataDir));
      const startedAt = new Date().toISOString();
      const child = this.spawnFn(executable, expanded, {
        cwd: config.cwd,
        env: childEnvironment(port, dataDir, this.options),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      record = { child, token: randomUUID(), port, data: dataDir, startedAt, stdout: '', stderr: '', spawnError: null };
      this.processes.set(labId, record);
      const capture = (stream, key) => {
        if (!stream) return;
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          const current = record[key] + String(chunk);
          record[key] = current.length > LOG_LIMIT ? current.slice(-LOG_LIMIT) : current;
        });
      };
      capture(child.stdout, 'stdout');
      capture(child.stderr, 'stderr');
      child.on('error', (error) => { record.spawnError = error.message; });
      const deadline = Date.now() + this.readyTimeoutMs;
      while (Date.now() < deadline) {
        if (record.spawnError) {
          fail(`Не удалось запустить демо: ${record.spawnError}. Используйте разрешённые псевдонимы node/python.`,
            'lab.spawn_failed', { id: labId, port });
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          const log = this.recordLog(record);
          fail(`Демо завершилось до проверки готовности (код ${child.exitCode ?? child.signalCode}). ${this.logTail(log)}`,
            'lab.exited_early', { id: labId, port, log });
        }
        if (usesPort) {
          if (await tryConnect(port, this.net, this.connectTimeoutMs)) {
            return this.readyOutcome(record, labId, port, dataDir, startedAt, usesPort);
          }
        } else if (Date.now() - new Date(startedAt).getTime() >= 750) {
          // Без {port} готовность означает устойчиво работающий процесс.
          return this.readyOutcome(record, labId, port, dataDir, startedAt, usesPort);
        }
        await this.sleepFn(100);
      }
      const log = this.recordLog(record);
      fail(`Демо не подтвердило готовность на 127.0.0.1:${port} за ${this.readyTimeoutMs} мс. ${this.logTail(log)}`,
        'lab.not_ready', { id: labId, port, log });
    } catch (error) {
      // Останавливаем только тот процесс, который создали сами.
      if (record && this.processes.get(labId) === record) {
        try { await this.stop(labId, { silent: true }); } catch { /* best effort */ }
      }
      if (error instanceof ActionError) throw error;
      fail(`Не удалось запустить демо: ${error.message}`, 'lab.start_failed', { id: labId, port });
    } finally {
      this.starting.delete(labId);
    }
  }

  readyOutcome(record, labId, port, dataDir, startedAt, usesPort) {
    return {
      ok: true,
      ready: true,
      labId,
      port,
      data: dataDir,
      startedAt,
      readyAt: new Date().toISOString(),
      log: this.recordLog(record),
      note: usesPort
        ? `Демо отвечает на 127.0.0.1:${port}.`
        : 'Процесс демонстрации стабильно работает; порт выделен и передан через PORT.',
    };
  }

  recordLog(record) {
    return { stdout: record.stdout, stderr: record.stderr };
  }

  logTail(log) {
    const tail = String(log.stderr || log.stdout || '').trim().split(/\r?\n/).slice(-3).join(' | ');
    return tail ? `Вывод демо: ${tail}` : 'Вывода демо нет.';
  }

  async stop(labId, options = {}) {
    const record = this.processes.get(labId);
    if (!record || !record.child) {
      return {
        ok: true,
        stopped: false,
        note: 'Подтверждённого запущенного процесса нет. Состояние помечено как остановленное; после перезапуска сервера running никогда не сохраняется.',
      };
    }
    const child = record.child;
    const alive = child.exitCode === null && child.signalCode === null;
    if (!alive) {
      this.processes.delete(labId);
      return { ok: true, stopped: false, endedAt: new Date().toISOString(), log: this.recordLog(record) };
    }
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
    });
    try {
      child.kill('SIGTERM');
    } catch (error) {
      if (!options.silent) fail(`Не удалось остановить процесс демо: ${error.message}`, 'lab.stop_failed', { id: labId });
    }
    await Promise.race([exited, this.sleepFn(this.stopGraceMs)]);
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* процесс уже ушёл */ }
      await Promise.race([exited, this.sleepFn(500)]);
    }
    const stillAlive = child.exitCode === null && child.signalCode === null;
    this.processes.delete(labId);
    const outcome = {
      ok: true,
      stopped: !stillAlive,
      endedAt: new Date().toISOString(),
      port: record.port,
      data: record.data,
      log: this.recordLog(record),
      note: stillAlive ? 'Процесс не подтверждён как остановленный; проверьте вручную.' : null,
    };
    if (!options.silent) this.log('debug', 'lab process stopped', { id: labId, port: record.port });
    return outcome;
  }

  // При ошибке запуска убираем процессе только из своего реестра; чужие PID не трогаем.
  forget(labId) {
    this.processes.delete(labId);
  }

  async close() {
    const ids = [...this.processes.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.stop(id, { silent: true })));
    for (const result of results) {
      if (result.status === 'rejected') this.log('warn', 'failed to stop lab during shutdown', { error: result.reason?.message });
    }
    for (const [labId, dir] of this.labDirs) {
      try {
        this.fs.rmSync(dir, { recursive: true, force: true });
      } catch (error) {
        this.log('warn', 'failed to remove lab data dir', { labId, dir, error: error.message });
      }
    }
    this.labDirs.clear();
    this.processes.clear();
    this.starting.clear();
  }
}

module.exports = {
  LabRunner,
  allocatePort,
  tryConnect,
  childEnvironment,
  defaultRunRoot,
};
