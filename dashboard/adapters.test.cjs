'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { observe } = require('./observer.cjs');
const {
  compileTicket, loadProfile, parsePort, profilesDir, REQUIRED_FIELDS,
} = require('./control.cjs');

const SECRET = 'SECRET_PROMPT_DO_NOT_LEAK_42';

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'adapters-test-'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

function writeLog(file, events) {
  fs.writeFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n', 'utf8');
}

test('observer: фильтрует по точному каноническому пути и сопоставляет данные запуска', () => {
  const root = makeRoot();
  try {
    const project = path.join(root, 'project');
    const other = path.join(root, 'other');
    const runRoot = path.join(root, 'runs');
    fs.mkdirSync(project);
    fs.mkdirSync(other);
    fs.mkdirSync(runRoot);

    const runA = path.join(runRoot, 'run-a');
    fs.mkdirSync(runA);
    const workerA = path.join(runA, 'server');
    fs.mkdirSync(workerA);
    writeJson(path.join(runA, 'manifest.json'), {
      source: project, baseline: path.join(runA, 'baseline'),
      workers: { server: workerA }, mode: 'copy', baseSha: 'abc1234',
    });
    writeJson(path.join(runA, 'summary.json'), {
      status: 'ok', run: runA, source: project, mode: 'copy', baseSha: 'abc1234',
      startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:10:00.000Z',
      workers: [{
        name: 'server', workerPath: workerA, model: 'opencode/big-pickle',
        parentSessionID: 'ses_parent_a', childSessionID: 'ses_child_a',
        status: 'completed', elapsedMs: 1234,
        changedPaths: [{ path: 'a.js', status: 'modified' }, { path: 'b.js', status: 'added' }],
      }],
    });
    writeLog(path.join(runA, 'server.jsonl'), [
      { type: 'step_start', timestamp: 1, sessionID: 'ses_parent_a' },
      { type: 'background_wait', timestamp: 2, sessionID: 'ses_parent_a',
        jobs: [{ id: 'ses_child_a', kind: 'subagent', title: 'work' }] },
      { type: 'step_finish', timestamp: 3, sessionID: 'ses_parent_a', part: { reason: 'stop' } },
    ]);
    fs.writeFileSync(path.join(runA, 'server.prompt.txt'), SECRET, 'utf8');
    const assembly = path.join(runA, 'assembly');
    writeJson(path.join(runA, 'assembly.json'), { assembly, workers: ['server'] });
    writeJson(path.join(runA, 'assembly.verify.json'), { assembly, status: 'ok' });

    const runOther = path.join(runRoot, 'run-other');
    fs.mkdirSync(runOther);
    writeJson(path.join(runOther, 'manifest.json'), { source: other, workers: {} });

    // Совпадающий проект, но без summary: данные берём из manifest и хвоста лога.
    const runC = path.join(runRoot, 'run-c');
    fs.mkdirSync(runC);
    writeJson(path.join(runC, 'manifest.json'), {
      source: project, mode: 'worktree', baseSha: 'deadbeef',
      workers: { ui: path.join(runC, 'ui') },
    });
    writeLog(path.join(runC, 'ui.jsonl'), [
      { type: 'step_start', timestamp: 1, sessionID: 'ses_live_parent' },
      { type: 'background_wait', timestamp: 2, sessionID: 'ses_live_parent',
        jobs: [{ id: 'ses_live_child', kind: 'subagent', title: 'ui' }] },
    ]);

    const runs = observe(project, { runRoot });
    assert.deepStrictEqual(runs.map((run) => run.id), ['run-a', 'run-c']);

    const first = runs[0];
    assert.equal(first.mode, 'copy');
    assert.equal(first.baseSha, 'abc1234');
    assert.equal(first.status, 'finished');
    assert.equal(first.updatedAt, '2026-01-01T00:10:00.000Z');
    assert.equal(first.workers.length, 1);
    assert.deepStrictEqual(first.workers[0], {
      name: 'server',
      path: workerA,
      model: 'opencode/big-pickle',
      parentSessionId: 'ses_parent_a',
      childSessionId: 'ses_child_a',
      status: 'completed',
      elapsedMs: 1234,
      changedPaths: ['a.js', 'b.js'],
    });
    assert.equal(first.assemblies.length, 1);
    assert.equal(first.assemblies[0].path, assembly);
    assert.equal(first.assemblies[0].verified, true);
    assert.match(first.assemblies[0].manifest, /assembly\.json$/);

    const second = runs[1];
    assert.equal(second.status, 'running');
    assert.equal(second.workers[0].childSessionId, 'ses_live_child');
    assert.equal(second.workers[0].parentSessionId, 'ses_live_parent');
    assert.equal(second.workers[0].status, 'running');

    assert.equal(JSON.stringify(runs).includes(SECRET), false);
    assert.equal(JSON.stringify(runs).toLowerCase().includes('accepted'), false);
  } finally {
    removeRoot(root);
  }
});

test('observer: повреждённый файл не скрывает данные другого файла', () => {
  const root = makeRoot();
  try {
    const project = path.join(root, 'project');
    const runRoot = path.join(root, 'runs');
    const run = path.join(runRoot, 'run-broken');
    fs.mkdirSync(project);
    fs.mkdirSync(run, { recursive: true });

    fs.writeFileSync(path.join(run, 'manifest.json'), '{broken', 'utf8');
    writeJson(path.join(run, 'summary.json'), {
      status: 'incomplete', source: project, mode: 'copy',
      workers: [{ name: 'worker', status: 'failed', changedPaths: [] }],
    });
    fs.writeFileSync(path.join(run, 'assembly.json'), 'not json', 'utf8');

    const runs = observe(project, { runRoot });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].id, 'run-broken');
    assert.equal(runs[0].workers[0].status, 'failed');
    assert.equal(runs[0].workers[0].changedPaths.length, 0);
    assert.deepStrictEqual(runs[0].assemblies, []);
  } finally {
    removeRoot(root);
  }
});

test('observer: устаревшие данные не называются живыми или принятыми', () => {
  const root = makeRoot();
  try {
    const project = path.join(root, 'project');
    const runRoot = path.join(root, 'runs');
    const run = path.join(runRoot, 'run-stale');
    fs.mkdirSync(project);
    fs.mkdirSync(run, { recursive: true });

    const manifest = path.join(run, 'manifest.json');
    const log = path.join(run, 'ui.jsonl');
    writeJson(manifest, { source: project, workers: { ui: path.join(run, 'ui') } });
    writeLog(log, [
      { type: 'step_start', sessionID: 'ses_old_parent' },
      { type: 'background_wait', sessionID: 'ses_old_parent',
        jobs: [{ id: 'ses_old_child', kind: 'subagent' }] },
    ]);
    const old = Date.now() - 3 * 60 * 60 * 1000;
    for (const file of [manifest, log]) fs.utimesSync(file, new Date(old), new Date(old));

    const runs = observe(project, { runRoot });
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'stale');
    assert.equal(runs[0].workers[0].status, 'stale');
    // Приёмка — решение человека, а не статус наблюдателя.
    assert.equal(runs[0].workers[0].childSessionId, 'ses_old_child');
    assert.equal(JSON.stringify(runs).toLowerCase().includes('accepted'), false);
  } finally {
    removeRoot(root);
  }
});

test('compile: сохраняет все поля тикета, включая критерии, у обоих профилей без сети', () => {
  const originalFetch = global.fetch;
  global.fetch = () => {
    throw new Error('compile не должен обращаться к сети');
  };
  try {
    const ticket = {
      goal: 'SC-01. Реализовать контракт HTTP/SQLite',
      context: 'inbound: ARCHITECTURE.md и исходные решения',
      contract: 'POST /items возвращает 201 и создаёт запись',
      writeScope: ['app.py', 'tests/'],
      criteria: [
        'SC-01: POST /items создаёт запись во временной БД',
        'SC-02: тесты проходят на изолированном порту 19101',
      ],
      report: 'ID сессии, файлы, команды, результаты, ограничения',
      extraField: 'сохранить-и-это',
      nested: { key: 'value' },
    };
    for (const selector of ['sol', 'big-pickle']) {
      const compiled = compileTicket(selector, ticket, { profilesDir });
      assert.equal(compiled.version, '1.0.0');
      assert.deepStrictEqual(compiled.ticket, ticket);
      for (const field of REQUIRED_FIELDS) {
        assert.match(compiled.prompt, new RegExp('### ' + field));
      }
      assert.match(compiled.prompt, /SC-01\. Реализовать контракт HTTP\/SQLite/);
      assert.match(compiled.prompt, /SC-01: POST \/items создаёт запись во временной БД/);
      assert.match(compiled.prompt, /SC-02: тесты проходят на изолированном порту 19101/);
      assert.match(compiled.prompt, /inbound: ARCHITECTURE\.md/);
      assert.match(compiled.prompt, /app\.py/);
      assert.match(compiled.prompt, /ID сессии, файлы, команды, результаты, ограничения/);
      assert.equal(compiled.ticket.extraField, 'сохранить-и-это');

      const profile = loadProfile(selector, { profilesDir });
      for (const section of [
        'Официальные рекомендации', 'Эмпирические наблюдения', 'Рубрика оценки',
        'Приём идей из других чатов', 'Передача этапа Figma',
        'references_approved', 'figma_approved',
      ]) {
        assert.equal(profile.content.includes(section), true, selector + ': нет секции ' + section);
      }
    }
  } finally {
    global.fetch = originalFetch;
  }
});

test('control: порт локальный и проверяется', () => {
  assert.equal(parsePort('18741'), 18741);
  assert.throws(() => parsePort('70000'), /порт/i);
  assert.throws(() => parsePort('abc'), /порт/i);
  assert.throws(() => parsePort(''), /порт/i);
});
