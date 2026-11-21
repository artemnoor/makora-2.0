'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createExecution, readRecord } = require('./execution.cjs');
const { verdict, packet, atomic } = require('./review.cjs');
const { fingerprint, requirePlan } = require('./plan.cjs');
const { captureSnapshot, composeArtifacts, sealArtifact, sourceManifest, realDirectory, verifyInventory, samePath, inside } = require('./artifacts.cjs');
const { BUSY, readyWork, selectBatch, reviewNeeded, invalidate, reviewClosure, elapsed } = require('./scheduler.cjs');

const FAILURE = ['failed', 'changes_requested', 'rejected', 'invalidated'];
const END = ['accepted', 'cancelled'];

function reason(error) {
  return String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 360);
}

function appendStatus(state, name, extra = {}) {
  state.history = [...(state.history ?? [state.state]), name];
  Object.assign(state, { state: name, ...extra });
}

function operationTime(attempts) {
  const current = Date.now();
  return elapsed(attempts.flatMap((attempt) => {
    if (attempt.kind === 'review' || attempt.kind === 'replan') {
      const times = attempt.activeInterval;
      return Array.isArray(times) ? [[times[0], times[1] ?? current]] : [];
    }
    return attempt.startedAt ? [[attempt.startedAt, attempt.finishedAt || current]] : [];
  }));
}

function recordUsage(run, attempts) {
  const modelAttempts = attempts.filter((attempt) => attempt.kind !== 'integrate' && attempt.channel !== 'session' && !BUSY.has(attempt.status));
  for (const key of ['tokens', 'costMicros']) {
    const values = modelAttempts.map((attempt) => attempt.usage?.[key]);
    run.budget[key] = values.length && values.every((value) => Number.isSafeInteger(value) && value >= 0)
      ? values.reduce((sum, value) => sum + value, 0) : null;
  }
}

function meteredBudgetReached(plan, run, attempts) {
  const billed = attempts.some((attempt) => ['batch', 'review', 'replan'].includes(attempt.kind) && attempt.channel !== 'session' && !BUSY.has(attempt.status));
  return billed && ['tokens', 'costMicros'].some((key) => plan.limits[key] &&
    (run.budget[key] == null || run.budget[key] >= plan.limits[key]));
}

function definition(node) {
  return fingerprint(node);
}

class RecursiveRunner {
  constructor({ repository, config, execution, reviewer, logger = () => {} }) {
    this.repo = repository;
    this.config = config;
    this.enabled = config?.enabled === true;
    this.execution = execution ?? createExecution(config?.execution);
    this.reviewer = reviewer;
    this.log = logger;
    this.inflight = new Map();
    this.ticking = false;
    this.closed = false;
  }

  listen() {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), 750);
    this.timer.unref();
    this.wake();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
  }

  wake() {
    if (this.enabled && !this.closed) setImmediate(() => this.tick());
  }

  start(payload, actor) {
    requirePlan(this.enabled, 'plan.disabled', 'Режим запускается только с явной конфигурацией Makora.');
    const storage = realDirectory(this.config.root);
    const project = this.repo.store.getProject(payload.projectId);
    const source = realDirectory(project.path);
    requirePlan(!samePath(source, storage) && !inside(source, storage), 'plan.storage', 'Хранилище должно находиться вне проекта.');
    const result = this.repo.start({ ...payload, allowReview: Boolean(this.reviewer && payload.allowReview === true) }, actor);
    this.wake();
    return result;
  }

  control(payload, actor) {
    requirePlan(actor === 'browser', 'browser_required', 'Управление запуском доступно в панели.');
    requirePlan(['pause', 'resume', 'cancel'].includes(payload.command), 'plan.control', 'Неизвестная команда.');
    const answer = this.repo.edit(payload.runId, (run) => {
      requirePlan(run.projectId === payload.projectId && !END.includes(run.status), 'plan.state', 'Этот запуск уже завершён.');
      if (payload.command === 'pause' && run.status === 'running') run.status = 'paused';
      if (payload.command === 'resume') {
        requirePlan(['paused', 'attention', 'unknown'].includes(run.status), 'plan.state', 'Запуск сейчас нельзя продолжить.');
        requirePlan(!this.repo.attempts(run.id).some((attempt) => attempt.status === 'unknown'),
          'plan.unknown', 'Сначала подтвердите завершение предыдущих сессий.');
        run.status = 'running';
        run.reason = null;
      }
      if (payload.command === 'cancel') run.status = 'cancelling';
      this.repo.store.audit(run.projectId, 'plan.' + payload.command, actor, { runId: run.id });
      return { ok: true, status: run.status };
    });
    this.wake();
    return answer;
  }

  sessionReview(payload, actor, submit = false) {
    requirePlan(actor === 'cli', 'cli_required', 'Пакеты ревью доступны через локальный CLI текущего чата.');
    const run = this.repo.run(payload.runId);
    requirePlan(run && run.projectId === payload.projectId, 'plan.run_missing', 'Запуск не найден в этом проекте.');
    const attempts = this.repo.attempts(run.id);
    if (!submit) {
      const pending = attempts.filter((item) => item.channel === 'session' && item.status === 'claimed').map((item) => {
        const artifact = this.repo.artifacts(run.id).find((entry) => entry.id === item.artifactId);
        const { deniedPaths, deadline, authorized, ...request } = item.request;
        return { ...request, revision: item.revision, nodeId: item.nodeIds[0], directory: artifact?.directory ?? null };
      });
      return { ok: true, pending };
    }
    const attempt = attempts.find((item) => item.id === payload.requestId && item.channel === 'session');
    requirePlan(attempt && attempt.status === 'claimed' && attempt.revision === run.revision &&
      ['running', 'paused'].includes(run.status), 'review.stale', 'Запрос ревью больше не актуален.');
    const result = verdict({ requestId: payload.requestId, assemblyHash: payload.assemblyHash,
      verificationHash: payload.verificationHash, decision: payload.decision, findings: payload.findings,
      proposal: payload.proposal == null ? '' : JSON.stringify(payload.proposal) }, attempt.request);
    requirePlan(attempt.kind !== 'replan' || !attempts.some((item) => item.id !== attempt.id && BUSY.has(item.status)),
      'plan.busy', 'Дождитесь завершения текущей попытки.');
    this.completeReview(run.id, attempt, { status: 'done', result: { ...result, channel: 'session' } });
    this.wake();
    return { ok: true, run: this.repo.publicRun(this.repo.run(run.id)) };
  }

  revise(payload, actor) {
    requirePlan(actor === 'cli', 'cli_required', 'Ревизия публикуется через локальный CLI.');
    const result = this.repo.edit(payload.runId, (run) => {
      requirePlan(run.projectId === payload.projectId && run.revision === payload.revision && !END.includes(run.status),
        'plan.revision', 'Ревизия больше не актуальна.');
      requirePlan(!this.repo.attempts(run.id).some((attempt) => BUSY.has(attempt.status)),
        'plan.busy', 'Дождитесь завершения текущих попыток.');
      this.applyRevision(run, payload.plan);
      return { ok: true, revision: run.revision };
    });
    this.wake();
    return result;
  }

  applyRevision(run, raw) {
    const { prior, next } = this.repo.revise(run, raw);
    const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
    const changed = new Set(prior.nodes.filter((node) =>
      !nextNodes.has(node.id) || definition(node) !== definition(nextNodes.get(node.id)) ||
      fingerprint(prior.nodes.filter((child) => child.parentId === node.id).map((child) => child.id)) !==
      fingerprint(next.nodes.filter((child) => child.parentId === node.id).map((child) => child.id)))
      .map((node) => node.id));
    const invalidIds = [...changed].map((id) => run.nodes[id]?.artifactId).filter(Boolean);
    invalidate(run, this.repo.artifacts(run.id), invalidIds);
    run.nodes = Object.fromEntries(next.nodes.map((node) => {
      const old = run.nodes[node.id];
      return [node.id, old && !changed.has(node.id) && !FAILURE.includes(old.state)
        ? old : { state: node.kind === 'leaf' ? 'approved' : 'planning' }];
    }));
    run.status = 'running';
    run.reason = null;
  }

  ensureBase(run, storage) {
    if (run.base) return run;
    const directory = path.join(storage, run.id);
    const record = path.join(directory, 'baseline.json');
    let snapshot;
    if (fs.existsSync(directory)) {
      requirePlan(fs.existsSync(record) && samePath(realDirectory(directory), directory), 'artifact.recovery', 'Создание снимка прервано до подтверждения.');
      snapshot = readRecord(record);
      const current = sourceManifest(run.projectPath);
      requirePlan(samePath(snapshot.source, realDirectory(run.projectPath)) &&
        samePath(snapshot.directory, path.join(directory, 'baseline')) &&
        snapshot.manifestHash === fingerprint(current) && fingerprint(snapshot.hashes) === fingerprint(current.hashes),
      'artifact.recovery', 'Снимок не соответствует исходному проекту.');
      verifyInventory(snapshot.directory, snapshot.hashes);
    } else {
      fs.mkdirSync(directory, { mode: 0o700 });
      snapshot = captureSnapshot(run.projectPath, path.join(directory, 'baseline'), storage);
      atomic(record, snapshot);
    }
    this.repo.edit(run.id, (current) => { current.base = snapshot; });
    return this.repo.run(run.id);
  }

  remaining(plan, run) {
    return Math.max(0, plan.limits.activeMs - operationTime(this.repo.attempts(run.id)));
  }

  enqueueOperation(run, plan, kind, selected) {
    const timestamp = Date.now();
    const limit = this.remaining(plan, run);
    const ids = selected[0].ids;
    const nodes = selected.map((entry) => entry.node);
    const op = { id: randomUUID(), kind, status: 'claimed', startedAt: timestamp, nodeIds: nodes.map((node) => node.id),
      inputIds: ids, nodes, deadline: timestamp + Math.min(plan.limits.attemptMs, limit) };
    const started = this.repo.edit(run.id, (current) => {
      if (current.status !== 'running' || current.epoch !== run.epoch) return false;
      const all = this.repo.active().flatMap((row) => this.repo.attempts(row.id));
      if (all.some((attempt) => ['batch', 'integrate'].includes(attempt.kind) && BUSY.has(attempt.status))) return false;
      const retryCounts = this.repo.attempts(run.id).filter((attempt) => attempt.kind === 'batch');
      if (kind === 'batch' && (meteredBudgetReached(plan, current, this.repo.attempts(run.id)) ||
        current.budget.attempts + nodes.length > plan.limits.attempts ||
        nodes.some((node) => retryCounts.filter((attempt) => attempt.nodeIds.includes(node.id)).length >= plan.limits.attemptsPerLeaf))) {
        current.status = 'budget_exhausted';
        current.reason = 'Исчерпан лимит исполнительских попыток.';
        return falseAfterWrite;
      }
      if (current.budget.checks + nodes.length > plan.limits.checks || limit <= 0 ||
        (kind === 'integrate' && current.budget.integrations >= plan.limits.integrations)) {
        current.status = 'budget_exhausted';
        current.reason = 'Исчерпан лимит проверок или активного времени.';
        return falseAfterWrite;
      }
      if (kind === 'batch') current.budget.attempts += nodes.length;
      if (kind === 'integrate') current.budget.integrations++;
      current.budget.checks += nodes.length;
      const accepted = new Set(Object.values(current.nodes).filter((state) => state.state === 'accepted').map((state) => state.artifactId));
      for (const node of nodes) appendStatus(current.nodes[node.id], kind === 'batch' ? 'queued' : 'integrating', {
        inputs: ids, provisionalInputs: ids.filter((id) => !accepted.has(id)),
      });
      const byId = new Map(plan.nodes.map((node) => [node.id, node]));
      for (const node of nodes) {
        for (let parent = byId.get(node.parentId); parent; parent = byId.get(parent.parentId)) {
          if (current.nodes[parent.id].state === 'planning') appendStatus(current.nodes[parent.id], 'executing');
        }
      }
      this.repo.recordAttempt(current, op);
      return true;
    });
    if (started === true) this.begin(run.id, op);
  }

  begin(runId, op) {
    if (this.inflight.has(op.id)) return;
    this.inflight.set(op.id, this.performOperation(runId, op).catch((error) => {
      if (!this.closed) {
        const attempt = this.repo.attempts(runId).find((item) => item.id === op.id);
        this.completeOperation(runId, op, { status: attempt?.status === 'claimed' ? 'failed' : 'unknown', reason: reason(error) });
      }
    }).finally(() => { this.inflight.delete(op.id); this.wake(); }));
  }

  async performOperation(runId, op) {
    const run = this.repo.run(runId);
    const folder = path.dirname(run.base.directory);
    const directory = path.join(folder, op.id);
    fs.mkdirSync(directory, { mode: 0o700 });
    const artifacts = this.repo.artifacts(runId);
    const input = op.inputIds.length
      ? composeArtifacts(run.base, artifacts, op.inputIds, path.join(directory, 'input'), this.config.root)
      : run.base;
    const job = { ...op, directory, input, nodeId: op.nodes[0].id, status: 'dispatched' };
    this.repo.edit(runId, (current) => {
      for (const node of op.nodes) {
        if (op.kind === 'batch') appendStatus(current.nodes[node.id], 'running', { inputs: input.usedArtifacts });
      }
      this.repo.recordAttempt(current, job);
    });
    let result;
    if (op.kind === 'batch') {
      result = await this.execution.runBatch(job);
    } else {
      const node = op.nodes[0];
      const checks = await this.execution.checks(job, input, node.checks);
      if (checks.status !== 'ok') result = checks;
      else {
        const artifact = sealArtifact({ directory: input.directory, input, dependencyArtifacts: input.usedArtifacts,
          verificationHash: checks.verificationHash, changes: [], nodeId: node.id });
        const records = artifacts.filter((item) => input.usedArtifacts.includes(item.id));
        const included = records.filter((item) => run.nodes[item.nodeId]?.artifactId === item.id && item.changes.length);
        const diff = included.map((item) => run.nodes[item.nodeId].evidence?.diff ?? '').join('\n');
        const testLogs = [checks.testLogs, ...records.filter((item) => op.inputIds.includes(item.id))
          .map((item) => run.nodes[item.nodeId]?.evidence?.testLogs ?? '')].join('\n');
        result = { status: 'done', outcomes: [{ status: 'ok', nodeId: node.id, artifact,
          hashes: input.hashes, evidence: { diff, testLogs } }] };
      }
    }
    atomic(path.join(directory, 'outcome.json'), { id: op.id, result });
    if (!this.closed) this.completeOperation(runId, job, result);
  }

  completeOperation(runId, op, result) {
    this.repo.edit(runId, (run) => {
      const saved = this.repo.attempts(runId).find((attempt) => attempt.id === op.id);
      if (!saved || !BUSY.has(saved.status)) return false;
      const status = result.status === 'done' ? 'done' : result.status === 'unknown' ? 'unknown' : 'failed';
      if (status === 'unknown' && saved.status === 'unknown') return false;
      this.repo.recordAttempt(run, { ...saved, status, finishedAt: status === 'unknown' ? null : Date.now(),
        runId: result.runId ?? null, reason: result.reason ?? null, usage: result.usage ?? null });
      run.budget.activeMs = operationTime(this.repo.attempts(runId));
      recordUsage(run, this.repo.attempts(runId));
      if (run.status === 'cancelling' || run.status === 'cancelled') return true;
      if (status === 'unknown') {
        if (run.status === 'running') run.status = 'unknown';
        run.reason = result.reason;
      } else if (run.status === 'unknown' && saved.status === 'unknown' &&
        !this.repo.attempts(runId).some((attempt) => attempt.status === 'unknown' && attempt.kind !== 'review' && attempt.kind !== 'replan')) {
        run.status = 'running';
        run.reason = null;
      }
      const outcomes = new Map((result.outcomes ?? []).map((item) => [item.nodeId, item]));
      for (const id of op.nodeIds) {
        const state = run.nodes[id];
        if (!state || state.state === 'invalidated') continue;
        const item = outcomes.get(id);
        if (item?.status === 'ok') {
          requirePlan(item.artifact.nodeId === id && item.artifact.inputManifestHash === saved.input.manifestHash &&
            fingerprint(item.artifact.dependencyArtifacts) === fingerprint([...saved.input.usedArtifacts].sort()),
          'execution.ownership', 'Артефакт относится к другим входам.');
          verifyInventory(item.artifact.directory, item.hashes);
          this.repo.recordArtifact(run, item.artifact);
          if (saved.kind === 'batch') appendStatus(state, 'executor_verified');
          appendStatus(state, 'tests_passed', { artifactId: item.artifact.id, hashes: item.hashes, evidence: item.evidence,
            verificationHash: item.artifact.verificationHash, assemblyHash: fingerprint(item.hashes), inputs: item.artifact.dependencyArtifacts });
        } else {
          const plan = this.repo.plan(run.projectId, run.planId, run.revision);
          const count = this.repo.attempts(runId).filter((attempt) => attempt.kind === 'batch' && attempt.nodeIds.includes(id)).length;
          const retry = item?.retryable === true && count < plan.limits.attemptsPerLeaf;
          appendStatus(state, status === 'unknown' ? 'unknown' : retry ? 'approved' : 'failed',
            { reason: item?.reason ?? result.reason ?? 'Проверка не завершена.' });
        }
      }
      return true;
    });
  }

  requestReview(run, plan, node, kind = 'review') {
    if (this.reviewer && (!run.allowReview || !this.reviewer.ready())) return;
    const attempts = this.repo.attempts(run.id);
    if (attempts.some((attempt) => ['review', 'replan'].includes(attempt.kind) && BUSY.has(attempt.status))) return;
    const state = run.nodes[node.id];
    const available = this.remaining(plan, run);
    const count = kind === 'review' ? 'reviews' : 'replans';
    const timeout = Math.min(kind === 'review' ? plan.limits.reviewMs : plan.limits.replanMs, available);
    if (run.budget[count] >= plan.limits[count] || (this.reviewer && (timeout <= 0 || meteredBudgetReached(plan, run, attempts)))) {
      this.repo.edit(run.id, (current) => { current.status = 'budget_exhausted'; current.reason = 'Исчерпан бюджет ' + count; });
      return;
    }
    const requestId = randomUUID();
    const evidenceNodes = kind === 'review' ? this.repo.artifacts(run.id)
      .filter((artifact) => state.inputs?.includes(artifact.id)) : [];
    const criteria = [node, ...plan.nodes.filter((entry) => evidenceNodes.some((artifact) => artifact.nodeId === entry.id))]
      .flatMap((entry) => entry.criteria.map((criterion) => entry.id + ' · ' + criterion));
    const request = {
      requestId, authorized: true, kind,
      assemblyHash: state.assemblyHash ?? run.base.manifestHash,
      verificationHash: state.verificationHash ?? fingerprint(state.reason ?? node.id),
      deadline: Date.now() + timeout, criteria,
      diff: state.evidence?.diff ?? '',
      testLogs: state.evidence?.testLogs ?? state.reason ?? 'Требуется изменение контракта.',
      deniedPaths: [run.projectPath, this.repo.store.dataDir, this.repo.store.dbPath],
      ...(kind === 'replan' ? { plan, failedNode: node.id } : {}),
    };
    try { if (this.reviewer) packet(request); }
    catch (error) {
      this.repo.edit(run.id, (current) => {
        current.nodes[node.id].reviewBlocked = true;
        current.reason = reason(error);
      });
      return;
    }
    const created = this.repo.edit(run.id, (current) => {
      if (current.epoch !== run.epoch || current.status !== 'running') return false;
      current.budget[count]++;
      if (kind === 'review') appendStatus(current.nodes[node.id], 'reviewing');
      this.repo.recordAttempt(current, { id: requestId, kind, status: 'claimed', nodeIds: [node.id],
        request, channel: this.reviewer ? 'adapter' : 'session', artifactId: state.artifactId ?? null, reservedAt: Date.now() });
      return true;
    });
    if (created) this.wake();
  }

  checkReview(runId, attempt) {
    try {
      const result = attempt.status === 'claimed'
        ? this.reviewer.enqueue(attempt.request)
        : this.reviewer.poll(attempt.request);
      if (result.status !== 'pending') return this.completeReview(runId, attempt, result);
      if (attempt.status === 'claimed') {
        this.repo.edit(runId, (run) => {
          this.repo.recordAttempt(run, { ...attempt, status: 'dispatched' });
        });
      } else if (attempt.status !== 'unknown' && Date.now() >= attempt.request.deadline + 5000) {
        this.completeReview(runId, attempt, { status: 'unknown', reason: 'Нет подтверждения завершения брокера.' });
      } else if (result.activeInterval && !attempt.activeInterval) {
        this.repo.edit(runId, (run) => this.repo.recordAttempt(run, { ...attempt, activeInterval: result.activeInterval }));
      }
    } catch (error) {
      if (error.code === 'review.unavailable' && Date.now() < attempt.request.deadline) return;
      const status = error.code === 'review.unavailable' && attempt.status === 'claimed' ? 'failed' : 'unknown';
      this.completeReview(runId, attempt, { status, reason: reason(error) });
    }
  }

  completeReview(runId, attempt, outcome) {
    this.repo.edit(runId, (run) => {
      const active = this.repo.attempts(runId).find((item) => item.id === attempt.id);
      if (!active || !BUSY.has(active.status)) return false;
      if (active.status === 'unknown' && outcome.status === 'unknown') return false;
      const state = run.nodes[attempt.nodeIds[0]];
      const response = outcome.status === 'done' ? verdict(outcome.result, attempt.request) : null;
      this.repo.recordAttempt(run, { ...attempt, status: response ? 'done' : outcome.status,
        reason: outcome.reason ?? null, activeInterval: outcome.activeInterval ?? attempt.activeInterval ?? null,
        usage: outcome.usage ?? null, finishedAt: Date.now() });
      run.budget.activeMs = operationTime(this.repo.attempts(runId));
      recordUsage(run, this.repo.attempts(runId));
      if (response) this.repo.recordReview(run, response);
      if (run.status === 'cancelling' || END.includes(run.status) || !state) return true;
      if (!response) {
        if (outcome.status !== 'unknown' && state.artifactId === attempt.artifactId && state.state === 'reviewing') appendStatus(state, 'tests_passed');
        run.reason = outcome.reason ?? 'Ревью ожидает подтверждения.';
        if (outcome.status !== 'unknown') state.reviewBlocked = true;
        return true;
      }
      if (attempt.kind === 'replan') {
        try {
          if (response.decision === 'approved') this.applyRevision(run, JSON.parse(response.proposal));
          else run.status = 'attention';
        } catch (error) { run.status = 'attention'; run.reason = reason(error); }
        return true;
      }
      if (state.artifactId !== attempt.artifactId || state.state !== 'reviewing') return true;
      const artifacts = this.repo.artifacts(run.id);
      if (response.decision === 'approved') {
        const accepted = reviewClosure(run, artifacts, attempt.artifactId);
        if (!accepted) { run.status = 'attention'; run.reason = 'Ревью относится к устаревшей сборке.'; return true; }
        const artifact = artifacts.find((item) => item.id === attempt.artifactId);
        verifyInventory(artifact.directory, state.hashes);
        const plan = this.repo.plan(run.projectId, run.planId, run.revision);
        if (attempt.nodeIds[0] === plan.rootId && fingerprint(sourceManifest(run.projectPath)) !== run.base.manifestHash) {
          run.status = 'attention';
          run.reason = 'Исходные файлы изменились после снимка. Для приёмки нужен новый запуск.';
          return true;
        }
        run.reason = null;
        for (const node of accepted) {
          if (node.state !== 'accepted') {
            appendStatus(node, 'codex_reviewed');
            appendStatus(node, 'accepted');
          }
        }
        const acceptedIds = new Set(accepted.map((node) => node.artifactId));
        for (const node of Object.values(run.nodes)) {
          if (node.provisionalInputs?.length) node.provisionalInputs = node.provisionalInputs.filter((id) => !acceptedIds.has(id));
        }
        if (run.nodes[plan.rootId].state === 'accepted') {
          run.status = 'accepted';
          run.result = { directory: artifact.directory, artifactId: artifact.id, assemblyHash: response.assemblyHash,
            verificationHash: response.verificationHash, reviewId: response.requestId };
        }
      } else {
        invalidate(run, artifacts, [attempt.artifactId]);
        appendStatus(state, response.decision, { reason: response.findings.join('\n').slice(0, 4000) });
      }
      return true;
    });
  }

  recoverOperation(runId, attempt) {
    if (this.inflight.has(attempt.id) || !attempt.directory) {
      if (!this.inflight.has(attempt.id) && !attempt.directory && Date.now() > (attempt.deadline ?? 0)) {
        this.completeOperation(runId, attempt, { status: 'unknown', reason: 'Резервирование прервано до записи запуска.' });
      }
      return;
    }
    const file = path.join(attempt.directory, 'outcome.json');
    if (fs.existsSync(file)) {
      const saved = readRecord(file);
      requirePlan(saved.id === attempt.id, 'execution.ownership', 'Отчёт другой попытки.');
      if (saved.result.status !== 'unknown') return this.completeOperation(runId, attempt, saved.result);
      this.completeOperation(runId, attempt, saved.result);
    }
    if (attempt.kind === 'batch' && this.execution.recover &&
      (attempt.status === 'unknown' || fs.existsSync(path.join(attempt.directory, 'batch-exit.json')) ||
        Date.now() > attempt.deadline + 35000 || this.execution.canRecover?.(attempt))) {
      this.inflight.set(attempt.id, Promise.resolve().then(() => this.execution.recover(attempt)).then((result) => {
        if (result.status !== 'unknown') atomic(file, { id: attempt.id, result });
        if (!this.closed && (result.status !== 'unknown' || Date.now() > attempt.deadline + 35000)) this.completeOperation(runId, attempt, result);
      }).catch((error) => {
        if (!this.closed) this.completeOperation(runId, attempt, { status: 'unknown', reason: reason(error) });
      }).finally(() => { this.inflight.delete(attempt.id); }));
    } else if (attempt.status !== 'unknown' && Date.now() > attempt.deadline + 35000) {
      this.completeOperation(runId, attempt, { status: 'unknown', reason: 'Нет подтверждения завершения запуска.' });
    }
  }

  cancelAttempt(run, attempt) {
    try {
      if (attempt.kind === 'review' || attempt.kind === 'replan') {
        if (attempt.channel === 'session') return this.completeReview(run.id, attempt, { status: 'cancelled' });
        if (!this.reviewer) return;
        const result = this.reviewer.cancel?.(attempt.request) ?? this.reviewer.poll?.(attempt.request);
        if (result && ['done', 'failed', 'cancelled'].includes(result.status)) this.completeReview(run.id, attempt, result);
      } else if (attempt.directory) {
        const state = this.execution.cancel(attempt);
        if (state.state === 'stopped' && !this.inflight.has(attempt.id)) {
          this.completeOperation(run.id, attempt, { status: 'failed', reason: 'Сессии остановлены.' });
        }
        this.recoverOperation(run.id, attempt);
      } else {
        this.recoverOperation(run.id, attempt);
      }
    } catch (error) { this.log('warn', 'reconciliation deferred', { id: attempt.id, reason: reason(error) }); }
  }

  cycle(initial) {
    let run = initial;
    if (run.status === 'cancelling') {
      const attempts = this.repo.attempts(run.id).filter((item) => BUSY.has(item.status));
      for (const attempt of attempts) this.cancelAttempt(run, attempt);
      if (!this.repo.attempts(run.id).some((item) => BUSY.has(item.status))) {
        this.repo.edit(run.id, (current) => { current.status = 'cancelled'; });
      }
      return;
    }
    for (const attempt of this.repo.attempts(run.id).filter((item) => BUSY.has(item.status))) {
      if (['review', 'replan'].includes(attempt.kind)) {
        if (this.reviewer && attempt.channel !== 'session' && !(run.status === 'paused' && attempt.status === 'claimed')) this.checkReview(run.id, attempt);
      }
      else if (attempt.nodeIds.some((id) => run.nodes[id]?.state === 'invalidated')) this.cancelAttempt(run, attempt);
      else this.recoverOperation(run.id, attempt);
    }
    run = this.repo.run(run.id);
    if (run.status !== 'running') return;
    run = this.ensureBase(run, this.config.root);
    const plan = this.repo.plan(run.projectId, run.planId, run.revision);
    const candidate = plan.nodes.find((node) =>
      run.nodes[node.id].state === 'tests_passed' && !run.nodes[node.id].reviewBlocked && reviewNeeded(plan, node));
    if (candidate) {
      this.requestReview(run, plan, candidate);
      run = this.repo.run(run.id);
    }
    if (run.status !== 'running') return;
    const { leaves, branches } = readyWork(plan, run);
    const batch = selectBatch(leaves, plan.limits.parallel);
    if (batch.length) this.enqueueOperation(run, plan, 'batch', batch);
    else if (branches.length) this.enqueueOperation(run, plan, 'integrate', [branches[0]]);
    else {
      const attempts = this.repo.attempts(run.id);
      const blocked = plan.nodes.find((node) => FAILURE.includes(run.nodes[node.id].state));
      if (candidate && this.reviewer && run.allowReview && !this.reviewer.ready() && !run.reason) {
        this.repo.edit(run.id, (current) => { current.reason = 'Ожидается доступность защищённого брокера ревью.'; });
      }
      if (blocked && !attempts.some((item) => BUSY.has(item.status)) &&
        !attempts.some((item) => item.kind === 'replan' && item.revision === run.revision)) {
        this.requestReview(run, plan, blocked, 'replan');
      }
    }
  }

  tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      for (const run of this.repo.active()) {
        try { this.cycle(run); }
        catch (error) {
          this.repo.edit(run.id, (current) => { current.status = 'attention'; current.reason = reason(error); });
          this.log('warn', 'recursive run stopped', { id: run.id, error: reason(error) });
        }
      }
    } finally { this.ticking = false; }
  }
}

const falseAfterWrite = Symbol('budget recorded');

module.exports = { RecursiveRunner };
