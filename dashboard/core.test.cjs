'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createDashboard } = require('./server.cjs');
const { Store, PHASES, DESIGN_STEPS } = require('./store.cjs');

function rmWithRetry(target) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function makeEnv(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-core-'));
  const dataDir = path.join(root, 'data');
  const projectPath = path.join(root, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  return {
    root,
    dataDir,
    projectPath,
    cleanup() { rmWithRetry(root); },
    create(options = {}) {
      return createDashboard({ dataDir, port: 0, readyTimeoutMs: 4000, ...extra, ...options });
    },
  };
}

function request(port, { method = 'GET', pathname = '/', headers = {}, body } = {}) {
  const payload = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const finalHeaders = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
  if (payload) {
    finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
    finalHeaders['Content-Length'] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: finalHeaders, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* не JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withDashboard(extra, fn) {
  const env = makeEnv(extra);
  let app;
  try {
    app = env.create();
    await app.listen();
    const browser = {
      Origin: `http://127.0.0.1:${app.port}`,
      'Sec-Fetch-Site': 'same-origin',
    };
    const post = (payload, headers) => request(app.port, { method: 'POST', pathname: '/api/actions', body: payload, headers });
    const get = (pathname, headers) => request(app.port, { pathname, headers });
    const addProject = async () => {
      const result = await post({ action: 'project.add', name: 'Тестовый проект', path: env.projectPath });
      assert.equal(result.json.ok, true, JSON.stringify(result.json));
      return result.json.projectId;
    };
    return await fn({ env, app, port: app.port, browser, post, get, addProject });
  } finally {
    if (app) await app.close();
    env.cleanup();
  }
}

const DEMO_SCRIPT = "require('node:http').createServer((q,s)=>s.end('ok')).listen({port},'127.0.0.1')";

test('SQLite сохраняет состояние, канонический путь, фазы и аудит между перезапусками', async () => {
  const env = makeEnv();
  let projectId;
  let app;
  try {
    {
      app = env.create();
      await app.listen();
      const post = (payload, headers) => request(app.port, { method: 'POST', pathname: '/api/actions', body: payload, headers });
      let result = await post({ action: 'project.add', name: 'Проект', path: env.projectPath });
      assert.equal(result.json.ok, true);
      projectId = result.json.projectId;
      result = await post({ action: 'project.add', name: 'Проект', path: env.projectPath + path.sep });
      assert.equal(result.json.idempotent, true);
      assert.equal(result.json.projectId, projectId);

      result = await post({ action: 'project.phase', projectId, phase: 'architecture' });
      assert.equal(result.json.ok, true);
      result = await post({ action: 'project.phase', projectId, phase: 'brief' });
      assert.equal(result.json.ok, undefined);
      assert.equal(result.json.code, 'phase.backward');

      result = await post({
        action: 'task.put', projectId, id: 'T-1', title: 'Задача', stage: 'implementation',
        status: 'done', criteria: ['критерий'], runId: 'run-1', sessionId: 'ses_1',
      });
      assert.equal(result.json.ok, true);
      result = await post({
        action: 'task.put', projectId, id: 'T-1', title: 'Задача', stage: 'implementation',
        status: 'done', criteria: ['критерий'], runId: 'run-1', sessionId: 'ses_1',
      });
      assert.equal(result.json.idempotent, true);

      result = await post({ action: 'idea.add', projectId, text: '  Сделать   проверку  ' });
      assert.equal(result.json.ok, true);
      const ideaId = result.json.ideaId;
      result = await post({ action: 'idea.add', projectId, text: 'сделать проверку' });
      assert.equal(result.json.idempotent, true);
      assert.equal(result.json.ideaId, ideaId);

      const state = (await request(app.port, { pathname: '/api/state' })).json;
      assert.equal(state.projects.length, 1);
      assert.equal(state.projects[0].phase, 'architecture');
      assert.equal(state.projects[0].tasks[0].accepted, false);
      assert.equal(state.projects[0].tasks[0].acceptance, 'pending');
      assert.equal(state.projects[0].runs[0].accepted, false);
      assert.equal(state.projects[0].ideas.length, 1);
      assert.equal(PHASES.includes(state.projects[0].phase), true);

      const audit = (await request(app.port, { pathname: `/api/audit?projectId=${encodeURIComponent(projectId)}` })).json;
      assert.ok(audit.entries.length >= 5);
      assert.ok(!Number.isNaN(Date.parse(audit.entries[0].ts)));
      await app.close();
    }
    {
      app = env.create();
      await app.listen();
      const state = (await request(app.port, { pathname: '/api/state' })).json;
      assert.equal(state.projects.length, 1);
      assert.equal(state.projects[0].id, projectId);
      assert.equal(state.projects[0].phase, 'architecture');
      assert.equal(state.projects[0].tasks[0].status, 'done');
      assert.equal(state.projects[0].tasks[0].accepted, false);
      assert.equal(state.projects[0].ideas.length, 1);
    }
  } finally {
    if (app) await app.close();
    env.cleanup();
  }
});

test('дизайн: полный путь через CLI-синхронизацию Figma и решения человека', async () => {
  await withDashboard({}, async ({ post, browser, addProject }) => {
    const projectId = await addProject();
    const designId = (await post({ action: 'design.create', projectId, title: 'Интерфейс' })).json.designId;
    assert.ok(designId);

    let result = await post({ action: 'design.advance', projectId, id: designId, step: 'references_ready', artifact: 'https://example.com/spec' });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));

    result = await post({ action: 'design.advance', projectId, id: designId, step: 'figma_ready', artifact: 'https://www.figma.com/design/x/F', frames: [{ nodeId: '1:2', name: 'Main' }] });
    assert.equal(result.json.code, 'design.figma_sync_required', JSON.stringify(result.json));

    result = await post({ action: 'design.advance', projectId, id: designId, step: 'references_approved' });
    assert.equal(result.json.code, 'browser_required');
    result = await post({ action: 'design.advance', projectId, id: designId, step: 'references_approved' }, browser);
    assert.equal(result.json.ok, true, JSON.stringify(result.json));

    // sync из браузера запрещён (CLI-only)
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'abcDEF123',
      frames: [{ nodeId: '10-2', name: 'Main' }],
    }, browser);
    assert.equal(result.json.code, 'cli_required', JSON.stringify(result.json));

    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'abcDEF123',
      frames: [{ nodeId: '10-2', name: 'Main' }, { nodeId: '3:4', name: 'Mobile' }], note: 'синхронизировано',
    });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    assert.equal(result.json.step, 'figma_ready');

    result = await post({ action: 'design.advance', projectId, id: designId, step: 'figma_approved' }, browser);
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    result = await post({ action: 'design.advance', projectId, id: designId, step: 'implemented', artifact: 'commit 1a2b3c' });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    result = await post({ action: 'design.advance', projectId, id: designId, step: 'reviewed', artifact: 'https://example.com/review' });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
  });
});

test('HTTP: loopback, Origin, same-origin для решений, размер JSON и отсутствие CORS', async () => {
  await withDashboard({}, async ({ post, get, port, browser, addProject }) => {
    const projectId = await addProject();
    const ideaId = (await post({ action: 'idea.add', projectId, text: 'Идея для решения' })).json.ideaId;

    let result = await request(port, { headers: { Host: 'evil.example' } });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'host.rejected');
    result = await request(port, { headers: { Host: `127.0.0.1:${port + 1}` } });
    assert.equal(result.status, 403);
    result = await request(port, { headers: { Origin: 'https://evil.example' } });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'origin.rejected');
    result = await request(port, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(result.status, 403);

    result = await get('/api/state');
    assert.equal(result.status, 200);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.equal(result.json.figmaConnected, undefined);
    assert.ok(!('figmaConnected' in result.json));

    result = await get('/');
    assert.equal(result.status, 200);
    const webDir = path.join(__dirname, 'web');
    const indexFile = path.join(webDir, 'index.html');
    if (fs.existsSync(indexFile)) {
      // Собранная панель отдаёт настоящие файлы dashboard/web, а не встроенную копию.
      assert.equal(result.text, fs.readFileSync(indexFile, 'utf8'));
      assert.match(result.text, /<title>Makora<\/title>/);
      for (const [name, contentType] of [['app.js', /javascript/], ['styles.css', /css/]]) {
        const file = path.join(webDir, name);
        if (!fs.existsSync(file)) continue;
        const asset = await get('/' + name);
        assert.equal(asset.status, 200);
        assert.match(asset.headers['content-type'], contentType);
        assert.equal(asset.text, fs.readFileSync(file, 'utf8'));
      }
    } else {
      assert.match(result.text, /Панель проектов/);
      assert.match(result.text, /не изменяет исходный код/);
    }

    // CLI без Origin может писать учётные действия.
    result = await post({ action: 'task.put', projectId, id: 'T-2', title: 'Из CLI', stage: 'brief', status: 'todo' });
    assert.equal(result.json.ok, true);

    // Решение человека без браузерного same-origin отвергается.
    result = await post({ action: 'idea.decide', projectId, id: ideaId, decision: 'accepted' });
    assert.equal(result.json.code, 'browser_required');
    result = await post({ action: 'idea.decide', projectId, id: ideaId, decision: 'accepted' }, {
      Origin: `http://127.0.0.1:${port}`,
      'Sec-Fetch-Site': 'cross-site',
    });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'fetch_site.rejected');
    result = await post({ action: 'idea.decide', projectId, id: ideaId, decision: 'accepted' }, browser);
    assert.equal(result.json.ok, true);

    result = await request(port, { method: 'POST', pathname: '/api/actions', body: '{ошибка' });
    assert.equal(result.status, 400);
    result = await request(port, { method: 'POST', pathname: '/api/actions', body: 'x'.repeat(70000) });
    assert.equal(result.status, 413);
    result = await request(port, { method: 'POST', pathname: '/api/actions', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(result.status, 415);
    result = await post({ action: 'неизвестное' });
    assert.equal(result.json.code, 'action.unknown');
  });
});

test('лаборатория: отрицательные переходы и полный путь до приёмки', async () => {
  await withDashboard({}, async ({ env, post, get, browser, addProject }) => {
    const projectId = await addProject();
    let result = await post({
      action: 'lab.propose', projectId, title: 'Демо', scenario: 'проверить сценарий',
      criteria: ['результат виден'], modulePaths: ['src/core.js'], demoPaths: ['src/core.js'],
    });
    assert.equal(result.json.code, 'lab.paths_overlap');

    result = await post({
      action: 'lab.propose', projectId, title: 'Демо', scenario: 'проверить сценарий',
      criteria: ['результат виден'], modulePaths: ['src/core.js'], demoPaths: ['demo/server.js'],
    });
    assert.equal(result.json.ok, true);
    const labId = result.json.labId;

    result = await post({ action: 'lab.start', projectId, id: labId }, browser);
    assert.equal(result.json.code, 'lab.state');
    result = await post({
      action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'node',
      args: ['-e', DEMO_SCRIPT], evidence: 'локальный демо-сервер',
    });
    assert.equal(result.json.code, 'lab.state');
    result = await post({ action: 'lab.decide', projectId, id: labId, decision: 'accepted' }, browser);
    assert.equal(result.json.code, 'lab.not_ready');
    result = await post({ action: 'lab.decide', projectId, id: labId, decision: 'approved' });
    assert.equal(result.json.code, 'browser_required');

    result = await post({ action: 'lab.decide', projectId, id: labId, decision: 'approved' }, browser);
    assert.equal(result.json.ok, true);

    const outside = path.dirname(env.projectPath);
    result = await post({
      action: 'lab.configure', projectId, id: labId, cwd: outside, runtime: 'node',
      args: ['-e', DEMO_SCRIPT], evidence: 'вне проекта',
    });
    assert.equal(result.json.code, 'lab.cwd_outside');
    result = await post({
      action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'bash',
      args: ['-e', DEMO_SCRIPT], evidence: 'неверная среда',
    });
    assert.equal(result.json.code, 'lab.runtime_invalid');
    result = await post({
      action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'node',
      args: '-e ' + DEMO_SCRIPT, evidence: 'аргументы строкой',
    });
    assert.equal(result.json.code, 'field.type');

    result = await post({
      action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'node',
      args: ['-e', DEMO_SCRIPT], evidence: 'локальный демо-сервер',
    });
    assert.equal(result.json.ok, true);
    result = await post({ action: 'lab.decide', projectId, id: labId, decision: 'accepted' }, browser);
    assert.equal(result.json.code, 'lab.not_ready');

    result = await post({ action: 'lab.start', projectId, id: labId }, browser);
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    assert.equal(result.json.ready, true);
    assert.ok(result.json.port > 0);

    let state = (await get('/api/state')).json;
    let lab = state.projects[0].labs[0];
    assert.equal(lab.state, 'ready');
    assert.equal(lab.runtime, 'ready');
    assert.equal(lab.readySeen, true);
    assert.equal(lab.lastRun.status, 'ready');

    result = await post({ action: 'lab.stop', projectId, id: labId }, browser);
    assert.equal(result.json.ok, true);
    state = (await get('/api/state')).json;
    lab = state.projects[0].labs[0];
    assert.equal(lab.runtime, 'stopped');
    assert.equal(lab.state, 'ready'); // остановка демо не является отзывом готовности

    result = await post({ action: 'lab.decide', projectId, id: labId, decision: 'accepted' }, browser);
    assert.equal(result.json.ok, true);
    assert.equal(result.json.state, 'accepted');
    result = await post({ action: 'lab.decide', projectId, id: labId, decision: 'accepted' }, browser);
    assert.equal(result.json.idempotent, true);
  });
});

test('неудачный запуск демо снимает готовность и блокирует приёмку', async () => {
  await withDashboard({}, async ({ env, post, get, browser, addProject }) => {
    const projectId = await addProject();
    const labId = (await post({
      action: 'lab.propose', projectId, title: 'Отрицательное демо', scenario: 'ошибка запуска',
      criteria: ['демо не стартует'], modulePaths: ['src/a.js'], demoPaths: ['demo/a.js'],
    })).json.labId;
    await post({ action: 'lab.decide', projectId, id: labId, decision: 'approved' }, browser);
    const configured = await post({
      action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'node',
      args: ['--несуществующий-флаг-демо'], evidence: 'проверка отрицательного запуска',
    });
    assert.equal(configured.json.ok, true);
    const started = await post({ action: 'lab.start', projectId, id: labId }, browser);
    assert.equal(started.json.ok, undefined);
    assert.ok(started.json.error);
    const state = (await get('/api/state')).json;
    const lab = state.projects[0].labs[0];
    assert.equal(lab.runtime, 'failed');
    assert.equal(lab.readySeen, false);
    assert.equal(lab.lastRun.status, 'failed');
    const accepted = await post({ action: 'lab.decide', projectId, id: labId, decision: 'accepted' }, browser);
    assert.equal(accepted.json.code, 'lab.not_ready');
  });
});

test('наблюдатель добавляет запуски без пометки приёмки; running не выживает после перезапуска', async () => {
  const env = makeEnv({
    observer: {
      observe(projectPath, { runRoot }) {
        assert.equal(typeof projectPath, 'string');
        assert.ok(projectPath.endsWith('project'));
        assert.equal(typeof runRoot, 'string');
        assert.ok(runRoot.length > 0);
        return [{ runId: 'obs-1', sessionId: 'ses_obs', status: 'completed', finishedAt: '2026-01-01T00:00:00.000Z' }];
      },
    },
  });
  let projectId;
  let labId;
  let app;
  try {
    {
      app = env.create();
      await app.listen();
      const post = (payload, headers) => request(app.port, { method: 'POST', pathname: '/api/actions', body: payload, headers });
      const browser = { Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' };
      projectId = (await post({ action: 'project.add', name: 'Проект', path: env.projectPath })).json.projectId;
      labId = (await post({
        action: 'lab.propose', projectId, title: 'Демо', scenario: 'сценарий', criteria: ['критерий'],
        modulePaths: ['src/a.js'], demoPaths: ['demo/a.js'],
      })).json.labId;
      await post({ action: 'lab.decide', projectId, id: labId, decision: 'approved' }, browser);
      await post({
        action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'node',
        args: ['-e', DEMO_SCRIPT], evidence: 'демо',
      });
      const state = (await request(app.port, { pathname: '/api/state' })).json;
      const observed = state.projects[0].runs.find((run) => run.runId === 'obs-1');
      assert.ok(observed);
      assert.equal(observed.source, 'observer');
      assert.equal(observed.accepted, false);
      assert.equal(observed.acceptance, 'pending');
      // Имитация состояния после аварийного завершения процесса.
      app.store.db.prepare("UPDATE labs SET runtime = 'running' WHERE id = ?").run(labId);
      await app.close();
    }
    {
      app = env.create();
      await app.listen();
      const state = (await request(app.port, { pathname: '/api/state' })).json;
      const lab = state.projects[0].labs.find((item) => item.id === labId);
      assert.notEqual(lab.runtime, 'running');
      assert.equal(lab.runtime, 'unverified');
      const audit = (await request(app.port, { pathname: `/api/audit?projectId=${projectId}` })).json;
      assert.ok(audit.entries.some((entry) => entry.action === 'lab.runtime.unverified'));
    }
  } finally {
    if (app) await app.close();
    env.cleanup();
  }
});

test('Store открывается с node:sqlite и хранит решения с метками времени', () => {
  const env = makeEnv();
  try {
    const store = new Store({ dataDir: env.dataDir });
    const project = store.perform({ action: 'project.add', name: 'P', path: env.projectPath }, { actor: 'cli' });
    store.perform({ action: 'idea.add', projectId: project.projectId, text: 'Идея' }, { actor: 'cli' });
    const state = store.getState();
    assert.equal(state.projects.length, 1);
    assert.ok(!('warnings' in state));
    const entries = store.auditEntries(project.projectId);
    assert.ok(entries.every((entry) => typeof entry.ts === 'string' && !Number.isNaN(Date.parse(entry.ts))));
    store.close();
  } finally {
    env.cleanup();
  }
});

test('design.figma.sync: канонические ссылки, нормализация, валидация, идемпотентность и persistence', async () => {
  const env = makeEnv();
  let app;
  try {
    app = env.create();
    await app.listen();
    const post = (payload, headers) => request(app.port, { method: 'POST', pathname: '/api/actions', body: payload, headers });
    const browser = { Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' };
    const projectId = (await post({ action: 'project.add', name: 'Проект', path: env.projectPath })).json.projectId;
    const designId = (await post({ action: 'design.create', projectId, title: 'Интерфейс' })).json.designId;

    // без references_approved запрещено
    let result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123',
      frames: [{ nodeId: '1:2', name: 'Main' }],
    });
    assert.equal(result.json.code, 'design.figma_sync_requires_references', JSON.stringify(result.json));

    assert.equal((await post({ action: 'design.advance', projectId, id: designId, step: 'references_ready', artifact: 'https://example.com/spec' })).json.ok, true);
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123',
      frames: [{ nodeId: '1:2', name: 'Main' }],
    });
    assert.equal(result.json.code, 'design.figma_sync_requires_references', JSON.stringify(result.json));

    assert.equal((await post({ action: 'design.advance', projectId, id: designId, step: 'references_approved' }, browser)).json.ok, true);

    // валидация payload
    for (const badKey of ['abc 123', 'abc/123', 'abc%20', 'abc\\def', 'abc.def', 'abc?x', 'abc#x', 'abc:123']) {
      result = await post({ action: 'design.figma.sync', projectId, id: designId, fileKey: badKey, frames: [{ nodeId: '1:2', name: 'Main' }] });
      assert.equal(result.json.code, 'design.figma_filekey_invalid', `${badKey}: ${JSON.stringify(result.json)}`);
    }
    result = await post({ action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123', frames: [] });
    assert.equal(result.json.code, 'field.required', JSON.stringify(result.json));
    result = await post({ action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123', frames: [{ nodeId: '1:2', name: '' }] });
    assert.equal(result.json.code, 'field.required', JSON.stringify(result.json));
    result = await post({ action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123', frames: ['Frame 1'] });
    assert.equal(result.json.code, 'field.type', JSON.stringify(result.json));
    for (const badNodeId of ['abc', 'https://figma.com/x', '1', '1:', ':2', '1:2:3', '1-2-3', '1.2', 'a:b', '1;2']) {
      result = await post({ action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123', frames: [{ nodeId: badNodeId, name: 'Main' }] });
      assert.equal(result.json.code, 'design.figma_nodeid_invalid', `${badNodeId}: ${JSON.stringify(result.json)}`);
    }
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'abc123',
      frames: [{ nodeId: '1-2', name: 'A' }, { nodeId: '1:2', name: 'B' }],
    });
    assert.equal(result.json.code, 'design.figma_duplicate_frame', JSON.stringify(result.json));

    // успешная sync: нормализация - -> : и канонические ссылки формируются сервером
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'AbC123x',
      frames: [{ nodeId: '10-2', name: 'Главный экран' }, { nodeId: '3:4', name: 'Мобайл' }],
      note: 'проверено',
    });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    assert.equal(result.json.idempotent, false);

    let state = (await request(app.port, { pathname: '/api/state' })).json;
    let design = state.projects[0].designs[0];
    assert.equal(design.step, 'figma_ready');
    assert.equal(design.stepIndex, 2);
    let entry = design.history[design.history.length - 1];
    assert.equal(entry.step, 'figma_ready');
    assert.equal(entry.source, 'figma-mcp');
    assert.equal(entry.verified, true);
    assert.equal(entry.fileKey, 'AbC123x');
    assert.equal(entry.fileUrl, 'https://www.figma.com/design/AbC123x');
    assert.equal(entry.artifact, 'https://www.figma.com/design/AbC123x');
    assert.equal(entry.note, 'проверено');
    assert.equal(entry.frames.length, 2);
    assert.deepEqual(entry.frames[0], { nodeId: '10:2', name: 'Главный экран', url: 'https://www.figma.com/design/AbC123x?node-id=10%3A2' });
    assert.deepEqual(entry.frames[1], { nodeId: '3:4', name: 'Мобайл', url: 'https://www.figma.com/design/AbC123x?node-id=3%3A4' });

    // идемпотентность
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'AbC123x',
      frames: [{ nodeId: '10-2', name: 'Главный экран' }, { nodeId: '3:4', name: 'Мобайл' }],
      note: 'проверено',
    });
    assert.equal(result.json.idempotent, true, JSON.stringify(result.json));
    state = (await request(app.port, { pathname: '/api/state' })).json;
    assert.equal(state.projects[0].designs[0].history.filter((item) => item.step === 'figma_ready').length, 1);

    // persistence
    await app.close();
    app = env.create();
    await app.listen();
    state = (await request(app.port, { pathname: '/api/state' })).json;
    entry = state.projects[0].designs[0].history[state.projects[0].designs[0].history.length - 1];
    assert.equal(entry.source, 'figma-mcp');
    assert.equal(entry.verified, true);
    assert.equal(entry.fileKey, 'AbC123x');
    assert.deepEqual(entry.frames[0].url, 'https://www.figma.com/design/AbC123x?node-id=10%3A2');
  } finally {
    if (app) await app.close();
    env.cleanup();
  }
});

test('design.figma.sync: обновление ручного figma_ready и запреты после figma_approved', async () => {
  await withDashboard({}, async ({ app, post, get, browser, addProject }) => {
    const projectId = await addProject();
    const designId = (await post({ action: 'design.create', projectId, title: 'Интерфейс' })).json.designId;
    assert.equal((await post({ action: 'design.advance', projectId, id: designId, step: 'references_ready', artifact: 'https://example.com/spec' })).json.ok, true);
    assert.equal((await post({ action: 'design.advance', projectId, id: designId, step: 'references_approved' }, browser)).json.ok, true);

    // имитация исторического ручного figma_ready до внедрения MCP-sync
    const ts = new Date().toISOString();
    app.store.db.prepare('UPDATE designs SET step = ?, step_index = ?, history = ?, updated_at = ? WHERE id = ?')
      .run('figma_ready', 2, JSON.stringify([
        { step: 'references_ready', artifact: 'https://example.com/spec', note: null, ts, source: 'cli' },
        { step: 'references_approved', artifact: null, note: null, ts, source: 'browser' },
        { step: 'figma_ready', artifact: 'https://www.figma.com/file/old/Old', frames: ['Old frame'], note: null, ts, source: 'cli' },
      ]), ts, designId);

    // без sync подтверждение невозможно
    let result = await post({ action: 'design.advance', projectId, id: designId, step: 'figma_approved' }, browser);
    assert.equal(result.json.code, 'design.figma_sync_required', JSON.stringify(result.json));

    // sync обновляет ручной figma_ready до подтверждения
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'NewKey',
      frames: [{ nodeId: '7:8', name: 'Новый' }],
    });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    assert.equal(result.json.updated, true, JSON.stringify(result.json));
    let state = (await get('/api/state')).json;
    let design = state.projects[0].designs[0];
    assert.equal(design.step, 'figma_ready');
    assert.equal(design.history.filter((item) => item.step === 'figma_ready').length, 1);
    const proof = design.history[design.history.length - 1];
    assert.equal(proof.source, 'figma-mcp');
    assert.equal(proof.fileKey, 'NewKey');
    assert.equal(proof.frames[0].url, 'https://www.figma.com/design/NewKey?node-id=7%3A8');

    result = await post({ action: 'design.advance', projectId, id: designId, step: 'figma_approved' }, browser);
    assert.equal(result.json.ok, true, JSON.stringify(result.json));

    // после figma_approved sync и изменения запрещены
    result = await post({
      action: 'design.figma.sync', projectId, id: designId, fileKey: 'Other',
      frames: [{ nodeId: '1:1', name: 'X' }],
    });
    assert.equal(result.json.code, 'design.figma_sync_blocked', JSON.stringify(result.json));
    result = await post({ action: 'design.advance', projectId, id: designId, step: 'implemented', artifact: 'commit' });
    assert.equal(result.json.ok, true, JSON.stringify(result.json)); // implemented still allowed in sequence
  });
});

test('дизайн: завершённые исторические записи читаются без миграции', async () => {
  await withDashboard({}, async ({ app, get, addProject }) => {
    const projectId = await addProject();
    const ts = '2025-01-02T03:04:05.000Z';
    const history = [
      { step: 'references_ready', artifact: 'https://example.com/spec', note: null, ts, source: 'cli' },
      { step: 'references_approved', artifact: null, note: 'ok', ts, source: 'browser' },
      { step: 'figma_ready', artifact: 'https://www.figma.com/file/legacy/Old', frames: ['Main', 'Mobile'], note: null, ts, source: 'cli' },
      { step: 'figma_approved', artifact: null, note: null, ts, source: 'browser' },
      { step: 'implemented', artifact: 'commit abc', note: null, ts, source: 'cli' },
      { step: 'reviewed', artifact: 'https://example.com/review', note: null, ts, source: 'cli' },
    ];
    app.store.db.prepare('INSERT INTO designs(id, project_id, title, step, step_index, history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('design_legacy1', projectId, 'Старый дизайн', 'reviewed', 5, JSON.stringify(history), ts, ts);

    const state = (await get('/api/state')).json;
    const design = state.projects[0].designs.find((item) => item.id === 'design_legacy1');
    assert.ok(design, 'legacy design must be present');
    assert.equal(design.step, 'reviewed');
    assert.equal(design.stepIndex, 5);
    assert.equal(design.nextStep, null);
    assert.equal(design.history.length, 6);
    const legacyFigma = design.history.find((item) => item.step === 'figma_ready');
    assert.deepEqual(legacyFigma.frames, ['Main', 'Mobile']);
    assert.equal(legacyFigma.artifact, 'https://www.figma.com/file/legacy/Old');
    // не MCP-доказательство, но запись читается как есть
    assert.notEqual(legacyFigma.source, 'figma-mcp');
  });
});

test('наблюдаемые запуски сохраняют данные исполнителя и обогащаются ссылкой задачи', async () => {
  const observedRuns = [
    {
      id: 'run-by-id', mode: 'worktree', baseSha: 'aaaaaaa', status: 'finished',
      updatedAt: '2026-02-01T10:00:00.000Z',
      workers: [{ name: 'server', status: 'completed', worktree: { head: 'aaaaaaa', branch: 'HEAD', dirty: false } }],
      assemblies: [{ path: 'C:/work/assembly', verified: true }],
    },
    {
      runId: 'run-by-runid', mode: 'copy', baseSha: 'bbbbbbb', status: 'running',
      updatedAt: '2026-02-02T11:00:00.000Z',
      workers: [], assemblies: [],
    },
    { id: 'run-unknown-time', status: 'pending', workers: [], assemblies: [] },
  ];
  const env = makeEnv({ observer: { observe() { return observedRuns; } } });
  let app;
  try {
    app = env.create();
    await app.listen();
    const post = (payload, headers) => request(app.port, { method: 'POST', pathname: '/api/actions', body: payload, headers });
    const projectId = (await post({ action: 'project.add', name: 'Проект', path: env.projectPath })).json.projectId;
    for (const [index, runId] of ['run-by-id', 'run-by-runid'].entries()) {
      const result = await post({
        action: 'task.put', projectId, id: `T-link-${index}`, title: `Задача ${index}`,
        stage: 'implementation', status: 'done', runId,
      });
      assert.equal(result.json.ok, true, JSON.stringify(result.json));
    }

    const state = (await request(app.port, { pathname: '/api/state' })).json;
    const runs = state.projects[0].runs;
    assert.equal(runs.length, 3, JSON.stringify(runs.map((run) => run.id)));

    const byId = runs.find((run) => run.id === 'run-by-id');
    assert.ok(byId);
    assert.equal(byId.source, 'observer');
    assert.equal(byId.mode, 'worktree');
    assert.equal(byId.baseSha, 'aaaaaaa');
    assert.equal(byId.status, 'finished');
    assert.equal(byId.updatedAt, '2026-02-01T10:00:00.000Z');
    assert.equal(byId.taskId, 'T-link-0');
    assert.deepEqual(byId.workers, observedRuns[0].workers);
    assert.deepEqual(byId.assemblies, observedRuns[0].assemblies);
    assert.equal(byId.accepted, false);
    assert.equal(byId.acceptance, 'pending');

    const byRunId = runs.find((run) => run.runId === 'run-by-runid');
    assert.ok(byRunId);
    assert.equal(byRunId.id, 'run-by-runid');
    assert.equal(byRunId.mode, 'copy');
    assert.equal(byRunId.baseSha, 'bbbbbbb');
    assert.equal(byRunId.taskId, 'T-link-1');
    assert.equal(byRunId.status, 'running');
    assert.equal(byRunId.updatedAt, '2026-02-02T11:00:00.000Z');

    const unknown = runs.find((run) => run.id === 'run-unknown-time');
    assert.ok(unknown);
    assert.equal(unknown.finishedAt, null);
    assert.equal(unknown.updatedAt, null);
  } finally {
    if (app) await app.close();
    env.cleanup();
  }
});

test('task.accept: явное CLI-решение отделено от статуса и не переносится на новую ревизию', async () => {
  const env = makeEnv();
  let app;
  try {
    app = env.create();
    await app.listen();
    const post = (payload, headers) => request(app.port, { method: 'POST', pathname: '/api/actions', body: payload, headers });
    const browser = { Origin: `http://127.0.0.1:${app.port}`, 'Sec-Fetch-Site': 'same-origin' };
    const projectId = (await post({ action: 'project.add', name: 'Проект', path: env.projectPath })).json.projectId;
    const putTask = (extra = {}) => post({
      action: 'task.put', projectId, id: 'T-1', title: 'Задача',
      stage: 'implementation', status: 'done', evidence: 'доказательство исполнителя', ...extra,
    });
    const taskOf = async () => {
      const state = (await request(app.port, { pathname: '/api/state' })).json;
      return state.projects[0].tasks[0];
    };

    assert.equal((await putTask()).json.ok, true);
    let task = await taskOf();
    assert.equal(task.status, 'done');
    assert.equal(task.accepted, false);
    assert.equal(task.acceptance, 'pending');

    let result = await post({ action: 'task.accept', projectId, id: 'T-1' });
    assert.equal(result.json.code, 'field.required');
    result = await post({ action: 'task.accept', projectId, id: 'T-1', evidence: '   ' });
    assert.equal(result.json.code, 'field.required');
    result = await post({ action: 'task.accept', projectId, id: 'T-1', evidence: 'подтверждение Codex' }, browser);
    assert.equal(result.json.code, 'cli_required');
    result = await post({ action: 'task.accept', projectId, id: 'T-1', evidence: 'подтверждение Codex' });
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    assert.equal(result.json.accepted, true);

    task = await taskOf();
    assert.equal(task.status, 'done');
    assert.equal(task.accepted, true);
    assert.equal(task.acceptance, 'accepted');
    assert.equal(task.acceptanceEvidence, 'подтверждение Codex');
    assert.equal(task.evidence, 'доказательство исполнителя');

    const audit = (await request(app.port, { pathname: `/api/audit?projectId=${encodeURIComponent(projectId)}` })).json;
    assert.ok(audit.entries.some((entry) => entry.action === 'task.accept'));
    const state = (await request(app.port, { pathname: '/api/state' })).json;
    assert.ok(state.projects[0].decisions.some((decision) => decision.type === 'task' &&
      decision.targetId === 'T-1' && decision.decision === 'accepted'));

    result = await post({ action: 'task.accept', projectId, id: 'T-1', evidence: 'подтверждение Codex' });
    assert.equal(result.json.idempotent, true);

    // Новый запуск после приёмки не наследует старое решение.
    assert.equal((await putTask({ runId: 'run-2' })).json.ok, true);
    task = await taskOf();
    assert.equal(task.accepted, false);
    assert.equal(task.acceptance, 'pending');
    assert.equal(task.acceptanceEvidence, null);
    let revised = (await request(app.port, { pathname: '/api/state' })).json;
    assert.equal(revised.projects[0].decisions.some((decision) => decision.type === 'task' &&
      decision.targetId === 'T-1' && decision.decision === 'accepted'), false);

    assert.equal((await post({ action: 'task.accept', projectId, id: 'T-1', evidence: 'подтверждение после исправления' })).json.ok, true);
    task = await taskOf();
    assert.equal(task.acceptanceEvidence, 'подтверждение после исправления');

    // Новая ревизия задачи тоже снимает прежнюю приёмку.
    assert.equal((await putTask({ runId: 'run-2', title: 'Задача после исправления' })).json.ok, true);
    task = await taskOf();
    assert.equal(task.accepted, false);
    assert.equal(task.acceptance, 'pending');
    revised = (await request(app.port, { pathname: '/api/state' })).json;
    assert.equal(revised.projects[0].decisions.some((decision) => decision.type === 'task' &&
      decision.targetId === 'T-1' && decision.decision === 'accepted'), false);

    // Без доказательств исполнителя принятие видно прямо в evidence задачи.
    const plain = await post({
      action: 'task.put', projectId, id: 'T-2', title: 'Простая задача',
      stage: 'api', status: 'done',
    });
    assert.equal(plain.json.ok, true);
    result = await post({ action: 'task.accept', projectId, id: 'T-2', evidence: 'доказательство Codex' });
    assert.equal(result.json.ok, true);
    const plainState = (await request(app.port, { pathname: '/api/state' })).json;
    const plainTask = plainState.projects[0].tasks.find((entry) => entry.id === 'T-2');
    assert.equal(plainTask.accepted, true);
    assert.equal(plainTask.evidence, 'доказательство Codex');
    assert.equal(plainTask.acceptanceEvidence, 'доказательство Codex');
  } finally {
    if (app) await app.close();
    env.cleanup();
  }
});

test('лаборатория: запуск и остановка требуют same-origin браузер, настройка доступна CLI', async () => {
  await withDashboard({}, async ({ env, post, get, port, browser, addProject }) => {
    const projectId = await addProject();
    const labId = (await post({
      action: 'lab.propose', projectId, title: 'Демо', scenario: 'сценарий', criteria: ['критерий'],
      modulePaths: ['src/a.js'], demoPaths: ['demo/a.js'],
    })).json.labId;
    assert.equal((await post({ action: 'lab.decide', projectId, id: labId, decision: 'approved' }, browser)).json.ok, true);
    // CLI по-прежнему настраивает демо без браузерного Origin.
    assert.equal((await post({
      action: 'lab.configure', projectId, id: labId, cwd: env.projectPath, runtime: 'node',
      args: ['-e', DEMO_SCRIPT], evidence: 'демо',
    })).json.ok, true);

    let result = await post({ action: 'lab.start', projectId, id: labId });
    assert.equal(result.json.code, 'browser_required');
    result = await post({ action: 'lab.start', projectId, id: labId }, { Origin: 'https://evil.example' });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'origin.rejected');
    result = await post({ action: 'lab.start', projectId, id: labId }, {
      Origin: `http://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site',
    });
    assert.equal(result.status, 403);
    assert.equal(result.json.code, 'fetch_site.rejected');

    result = await post({ action: 'lab.start', projectId, id: labId }, browser);
    assert.equal(result.json.ok, true, JSON.stringify(result.json));
    assert.equal((await post({ action: 'lab.stop', projectId, id: labId })).json.code, 'browser_required');
    result = await post({ action: 'lab.stop', projectId, id: labId }, browser);
    assert.equal(result.json.ok, true);
    const state = (await get('/api/state')).json;
    assert.equal(state.projects[0].labs[0].runtime, 'stopped');
  });
});
