'use strict';

const { randomUUID } = require('node:crypto');
const { PlanError, requirePlan, normalizePlan, draftPlan, changedScope } = require('./plan.cjs');

const ACTIVE = ['running', 'paused', 'cancelling', 'unknown', 'budget_exhausted', 'attention'];
const schema = 'CREATE TABLE IF NOT EXISTS plans ('
  + ' project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,'
  + ' definition TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(project_id,plan_id,revision));'
  + 'CREATE TABLE IF NOT EXISTS work_nodes ('
  + ' project_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, node_id TEXT NOT NULL, parent_id TEXT,'
  + ' PRIMARY KEY(project_id,plan_id,revision,node_id), FOREIGN KEY(project_id,plan_id,revision) REFERENCES plans ON DELETE CASCADE);'
  + 'CREATE TABLE IF NOT EXISTS node_dependencies ('
  + ' project_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, node_id TEXT NOT NULL, dependency TEXT NOT NULL,'
  + ' PRIMARY KEY(project_id,plan_id,revision,node_id,dependency),'
  + ' FOREIGN KEY(project_id,plan_id,revision,node_id) REFERENCES work_nodes ON DELETE CASCADE,'
  + ' FOREIGN KEY(project_id,plan_id,revision,dependency) REFERENCES work_nodes ON DELETE CASCADE);'
  + 'CREATE TABLE IF NOT EXISTS plan_runs ('
  + ' id TEXT PRIMARY KEY, project_id TEXT NOT NULL, plan_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,'
  + ' epoch INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, FOREIGN KEY(project_id,plan_id,revision) REFERENCES plans ON DELETE CASCADE);'
  + "CREATE UNIQUE INDEX IF NOT EXISTS recursive_active ON plan_runs(project_id) WHERE status IN ('running','paused','cancelling','unknown','budget_exhausted','attention');"
  + 'CREATE TABLE IF NOT EXISTS attempts ('
  + ' id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES plan_runs ON DELETE CASCADE, revision INTEGER NOT NULL,'
  + ' kind TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);'
  + 'CREATE INDEX IF NOT EXISTS attempts_by_run ON attempts(run_id);'
  + 'CREATE TABLE IF NOT EXISTS artifacts ('
  + ' id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES plan_runs ON DELETE CASCADE, data TEXT NOT NULL, PRIMARY KEY(run_id,id));'
  + 'CREATE TABLE IF NOT EXISTS reviews ('
  + ' id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES plan_runs ON DELETE CASCADE, artifact_hash TEXT NOT NULL,'
  + ' verification_hash TEXT NOT NULL, data TEXT NOT NULL);';

const json = JSON.stringify;
const read = JSON.parse;

class RecursiveRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
  }

  migrate() {
    this.db.exec(schema);
  }

  plan(projectId, planId, revision) {
    const row = revision == null
      ? this.db.prepare('SELECT * FROM plans WHERE project_id=? AND plan_id=? ORDER BY revision DESC LIMIT 1').get(projectId, planId)
      : this.db.prepare('SELECT * FROM plans WHERE project_id=? AND plan_id=? AND revision=?').get(projectId, planId, revision);
    return row ? { projectId, revision: row.revision, ...read(row.definition) } : null;
  }

  insertPlan(projectId, plan, revision) {
    this.db.prepare('INSERT INTO plans VALUES (?,?,?,?,?)').run(projectId, plan.id, revision, json(plan), this.store.now());
    const addNode = this.db.prepare('INSERT INTO work_nodes VALUES (?,?,?,?,?)');
    for (const node of plan.nodes) addNode.run(projectId, plan.id, revision, node.id, node.parentId);
    const addDependency = this.db.prepare('INSERT INTO node_dependencies VALUES (?,?,?,?,?)');
    for (const node of plan.nodes) {
      for (const dependency of node.dependsOn) addDependency.run(projectId, plan.id, revision, node.id, dependency);
    }
  }

  put(payload, actor) {
    requirePlan(actor === 'cli', 'cli_required', 'Черновик публикуется через локальный CLI.');
    const project = this.store.getProject(payload.projectId);
    const plan = normalizePlan(payload.action === 'plan.draft' ? draftPlan(payload) : payload);
    return this.store.transaction(() => {
      const current = this.plan(project.id, plan.id);
      if (current?.fingerprint === plan.fingerprint) return { ok: true, plan: current, idempotent: true };
      requirePlan((payload.expectedRevision ?? 0) === (current?.revision ?? 0),
        'plan.revision', 'Ревизия изменилась. Обновите состояние.');
      const revision = (current?.revision ?? 0) + 1;
      this.insertPlan(project.id, plan, revision);
      this.store.audit(project.id, 'plan.put', actor, { planId: plan.id, revision });
      return { ok: true, plan: { ...plan, projectId: project.id, revision } };
    });
  }

  run(id) {
    const row = this.db.prepare('SELECT * FROM plan_runs WHERE id=?').get(id);
    if (!row) return null;
    return { id, planId: row.plan_id, revision: row.revision, projectId: row.project_id,
      status: row.status, epoch: row.epoch, ...read(row.data) };
  }

  setRun(run) {
    const { id, planId, revision, projectId, status, epoch, ...state } = run;
    const result = this.db.prepare('UPDATE plan_runs SET revision=?,status=?,epoch=epoch+1,data=? WHERE id=? AND epoch=?')
      .run(revision, status, json(state), id, epoch);
    requirePlan(result.changes === 1, 'plan.concurrent', 'Другое действие уже изменило запуск.');
  }

  list(projectId) {
    return this.db.prepare('SELECT plan_id, MAX(revision) AS revision FROM plans WHERE project_id=? GROUP BY plan_id')
      .all(projectId).map(({ plan_id: planId, revision }) => {
        const plan = this.plan(projectId, planId, revision);
        const row = this.db.prepare('SELECT id FROM plan_runs WHERE project_id=? AND plan_id=? ORDER BY rowid DESC LIMIT 1').get(projectId, planId);
        return { ...plan, run: row ? this.publicRun(this.run(row.id)) : null };
      });
  }

  publicRun(run) {
    const { id, revision, status, nodes, budget, startedAt, reason, allowReview, result } = run;
    const evidence = this.db.prepare('SELECT id,kind,status,data FROM attempts WHERE run_id=? ORDER BY rowid').all(id).map((row) => {
      const data = read(row.data);
      return { id: row.id, kind: row.kind, status: row.status, runId: data.runId ?? null, reason: data.reason ?? null,
        channel: data.channel ?? null };
    });
    const summary = Object.fromEntries(Object.entries(nodes).map(([id, state]) => [id, {
      state: state.state, artifactId: state.artifactId ?? null, reason: state.reason ?? null, reviewBlocked: state.reviewBlocked ?? false,
      provisionalInputs: state.provisionalInputs ?? [],
    }]));
    return { id, revision, status, nodes: summary, budget, startedAt, reason: reason ?? null, allowReview, evidence, result: result ?? null,
      baseline: run.base ? { baseSha: run.base.baseSha, manifestHash: run.base.manifestHash, edits: run.base.edits } : null };
  }

  active() {
    return this.db.prepare('SELECT id,status FROM plan_runs ORDER BY rowid').all()
      .filter((row) => ACTIVE.includes(row.status)).map((row) => this.run(row.id));
  }

  start(payload, actor) {
    requirePlan(actor === 'browser', 'browser_required', 'Запуск плана подтверждается в панели.');
    const project = this.store.getProject(payload.projectId);
    return this.store.transaction(() => {
      const plan = this.plan(project.id, payload.id);
      requirePlan(plan && plan.revision === payload.revision && plan.fingerprint === payload.fingerprint,
        'plan.revision', 'Подтвердите актуальный план.');
      const previous = this.db.prepare('SELECT id FROM plan_runs WHERE project_id=? AND plan_id=? AND revision=?')
        .get(project.id, plan.id, plan.revision);
      if (previous) return { ok: true, run: this.publicRun(this.run(previous.id)), idempotent: true };
      requirePlan(!this.active().some((run) => run.projectId === project.id),
        'plan.active', 'В проекте уже есть незавершённый запуск.');
      const runId = randomUUID();
      const startedAt = this.store.now();
      const data = {
        projectPath: project.path, startedAt, allowReview: payload.allowReview === true, initialPlan: plan.revision,
        budget: { nodes: plan.nodes.length, attempts: 0, reviews: 0, replans: 0, checks: 0, integrations: 0, activeMs: 0,
          tokens: null, costMicros: null },
        nodes: Object.fromEntries(plan.nodes.map((node) => [node.id, { state: node.kind === 'leaf' ? 'approved' : 'planning' }])),
        base: null,
      };
      this.db.prepare('INSERT INTO plan_runs(id,project_id,plan_id,revision,status,data) VALUES (?,?,?,?,?,?)')
        .run(runId, project.id, plan.id, plan.revision, 'running', json(data));
      this.store.audit(project.id, 'plan.start', actor, { runId, planId: plan.id, revision: plan.revision, allowReview: data.allowReview });
      return { ok: true, run: this.publicRun(this.run(runId)) };
    });
  }

  edit(id, fn) {
    return this.store.transaction(() => {
      const run = this.run(id);
      requirePlan(run, 'plan.run_missing', 'Запуск не найден.');
      const result = fn(run);
      if (result !== false) this.setRun(run);
      return result;
    });
  }

  attempts(runId) {
    return this.db.prepare('SELECT * FROM attempts WHERE run_id=? ORDER BY rowid').all(runId)
      .map((row) => ({ ...read(row.data), id: row.id, kind: row.kind, status: row.status, revision: row.revision }));
  }

  recordAttempt(run, attempt) {
    const { id, kind, status, ...data } = attempt;
    this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data')
      .run(id, run.id, run.revision, kind, status, json(data));
  }

  recordArtifact(run, artifact) {
    this.db.prepare('INSERT OR IGNORE INTO artifacts VALUES (?,?,?)').run(artifact.id, run.id, json(artifact));
  }

  artifacts(runId) {
    return this.db.prepare('SELECT data FROM artifacts WHERE run_id=? ORDER BY rowid').all(runId).map((row) => read(row.data));
  }

  recordReview(run, response) {
    const old = this.db.prepare('SELECT data FROM reviews WHERE id=? AND run_id=?').get(response.requestId, run.id);
    if (old && old.data !== json(response)) throw new PlanError('review.conflict', 'Решение для этого запроса уже сохранено.');
    if (!old) this.db.prepare('INSERT INTO reviews VALUES (?,?,?,?,?)')
      .run(response.requestId, run.id, response.assemblyHash, response.verificationHash, json(response));
  }

  revise(run, raw) {
    const prior = this.plan(run.projectId, run.planId, run.revision);
    const approved = this.plan(run.projectId, run.planId, run.initialPlan);
    const next = normalizePlan({ ...raw, id: run.planId });
    requirePlan(!changedScope(approved, next), 'plan.approval_required', 'Ревизия меняет утверждённые полномочия.');
    const priorIds = new Set(prior.nodes.map((node) => node.id));
    const added = next.nodes.filter((node) => !priorIds.has(node.id)).length;
    requirePlan(run.budget.nodes + added <= approved.limits.nodes, 'plan.budget', 'Исчерпан лимит узлов плана.');
    const revision = this.plan(run.projectId, run.planId).revision + 1;
    this.insertPlan(run.projectId, next, revision);
    run.revision = revision;
    run.budget.nodes += added;
    return { prior, next };
  }
}

module.exports = { RecursiveRepository, ACTIVE };
