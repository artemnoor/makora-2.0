'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: wait } = require('node:timers/promises');
const { Store } = require('../store.cjs');
const { RecursiveRunner } = require('./runtime.cjs');
const { LIMITS, normalizePlan, changedScope, fingerprint, hashBytes } = require('./plan.cjs');
const { captureSnapshot, composeArtifacts, copyVerified, inventory, changesBetween, sealArtifact } = require('./artifacts.cjs');
const { readyWork, invalidate } = require('./scheduler.cjs');
const { createExecution, localProcess } = require('./execution.cjs');
const { compareTrees, artifactHashes } = require('../../verified-workspaces.cjs');
const { createReviewQueue, runBroker, packet } = require('./review.cjs');
const { createOpenCodeClient, API, VERSION } = require('./opencode.cjs');

const MODEL = 'opencode/big-pickle';
const checks = [{ executable: 'node', args: ['-e', 'process.exit(0)'] }];
const criteria = ['Pass the acceptance check'];
const evidenceHash = fingerprint('verified');

function branch(id, parentId = null, dependsOn = []) {
  return { id, parentId, dependsOn, kind: 'branch', title: id, checks, criteria };
}

function leaf(id, parentId = null, dependsOn = [], relative = id + '.txt') {
  return { ...branch(id, parentId, dependsOn), kind: 'leaf', goal: 'Write the file', contract: 'Preserve the input',
    model: MODEL, profile: MODEL, writeScope: [relative] };
}

function plan(nodes, limits = {}) {
  return { id: 'pilot', title: 'Pilot', requirements: 'Implement the named files', nodes, limits };
}

function folders(t, after = () => {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'makora-recursive-'));
  t.after(() => {
    after();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 8 });
  });
  const source = fs.mkdirSync(path.join(base, 'project'), { recursive: true });
  const storage = fs.mkdirSync(path.join(base, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(source, 'initial.txt'), 'before');
  return { base, source, storage, dataDir: path.join(base, 'data') };
}

function createArtifact(input, directory, node, text) {
  fs.mkdirSync(directory);
  copyVerified(input.directory, directory, input.hashes);
  const file = path.join(directory, node.writeScope[0]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const hashes = inventory(directory);
  const artifact = sealArtifact({ directory, input, dependencyArtifacts: input.usedArtifacts,
    changes: changesBetween(input.hashes, hashes), verificationHash: evidenceHash, nodeId: node.id });
  return { artifact, hashes };
}

function successful(job, node) {
  return { nodeId: node.id, status: 'ok', ...createArtifact(job.input, path.join(job.directory, node.id), node, node.id),
    evidence: { diff: '+ ' + node.id, testLogs: 'executor checked ' + node.id } };
}

function fakeExecution() {
  const jobs = [];
  return { jobs,
    async runBatch(job) { jobs.push(job); return { status: 'done', outcomes: job.nodes.map((node) => successful(job, node)) }; },
    async checks() { return { status: 'ok', verificationHash: evidenceHash, testLogs: 'integration passed' }; },
    cancel() { return { state: 'stopped' }; },
  };
}

function response(request, decision = 'approved') {
  const { requestId, assemblyHash, verificationHash } = request;
  return { requestId, assemblyHash, verificationHash, decision, findings: [], proposal: '' };
}

function reviewer(options = {}) {
  const requests = [];
  const results = new Map();
  return { requests, results, ready: () => options.ready !== false,
    enqueue(request) { if (!requests.some((item) => item.requestId === request.requestId)) requests.push(request); return this.poll(request); },
    poll(request) { return results.get(request.requestId) ?? (options.approve ? { status: 'done', result: response(request) } : { status: 'pending' }); },
    cancel() { return { status: 'cancelled' }; },
  };
}

function fixture(t, selected, options = {}) {
  let store;
  let runner;
  const paths = folders(t, () => { runner?.close(); store?.close(); });
  const execution = options.execution ?? fakeExecution();
  const adapter = options.reviewer === null ? undefined : (options.reviewer ?? reviewer({ approve: true }));
  function open() {
    store = new Store({ dataDir: paths.dataDir });
    runner = new RecursiveRunner({ repository: store.recursive, execution, reviewer: adapter,
      config: { enabled: true, root: paths.storage, review: { enabled: true } } });
  }
  open();
  const project = store.perform({ action: 'project.add', name: 'pilot', path: paths.source }).project;
  const { plan: draft } = store.perform({ action: 'plan.put', ...selected, projectId: project.id });
  const { run } = runner.start({ id: draft.id, projectId: project.id, revision: draft.revision,
    fingerprint: draft.fingerprint, allowReview: true }, 'browser');
  const state = () => store.recursive.run(run.id);
  async function until(predicate) {
    for (let attempt = 0; attempt < 120; attempt++) {
      runner.tick();
      const current = state();
      if (predicate(current)) return current;
      if (['attention', 'unknown'].includes(current.status)) assert.fail(JSON.stringify(current));
      await wait(8);
    }
    assert.fail(JSON.stringify(state()));
  }
  return { ...paths, execution, adapter, state, until, project, runId: run.id,
    get store() { return store; }, get runner() { return runner; },
    command(command) { return runner.control({ projectId: project.id, runId: run.id, command }, 'browser'); },
    reopen() { runner.close(); store.close(); open(); },
  };
}

test('graph allows 24 levels, rejects implicit cycles and binds approved commands', () => {
  const nodes = Array.from({ length: 23 }, (_, n) => branch('branch-' + n, n ? 'branch-' + (n - 1) : null));
  nodes.push(leaf('end', 'branch-22'));
  const current = normalizePlan(plan(nodes));
  assert.equal(current.nodes.length, 24);
  const invalid = nodes.map((node) => node.id === 'branch-0' ? { ...node, dependsOn: ['end'] } : node);
  assert.throws(() => normalizePlan(plan(invalid)), { code: 'plan.cycle' });
  const newModel = nodes.map((node) => node.kind === 'leaf' ? { ...node, model: 'opencode/test', profile: 'opencode/test' } : node);
  assert.equal(changedScope(current, normalizePlan(plan(newModel))), true);
  assert.equal(changedScope(current, normalizePlan(plan(nodes, { attempts: LIMITS.attempts + 1 }))), true);
});

test('snapshot and successive batches prove exact inputs, block conflicting sibling changes', (t) => {
  const { source, storage } = folders(t);
  fs.writeFileSync(path.join(source, '.env'), 'excluded');
  const base = captureSnapshot(source, path.join(storage, 'baseline'), storage, { 'initial.txt': hashBytes('before') });
  assert.equal(base.hashes['.env'], undefined);
  const first = createArtifact(base, path.join(storage, 'first'), leaf('a', null, [], 'initial.txt'), 'A').artifact;
  const next = composeArtifacts(base, [first], [first.id], path.join(storage, 'input'), storage);
  const second = createArtifact(next, path.join(storage, 'second'), leaf('b', null, [], 'initial.txt'), 'B').artifact;
  const combined = composeArtifacts(base, [first, second], [second.id], path.join(storage, 'merged'), storage);
  assert.equal(fs.readFileSync(path.join(combined.directory, 'initial.txt'), 'utf8'), 'B');
  assert.equal(fs.readFileSync(path.join(source, 'initial.txt'), 'utf8'), 'before');
  const conflict = createArtifact(base, path.join(storage, 'conflict'), leaf('c', null, [], 'initial.txt'), 'C').artifact;
  assert.throws(() => composeArtifacts(base, [first, conflict], [first.id, conflict.id], path.join(storage, 'bad'), storage),
    { code: 'artifact.conflict' });
});

test('provisional results are local to the branch and rejected inputs invalidate their consumers', () => {
  const draft = normalizePlan(plan([branch('root'), branch('left', 'root'), branch('right', 'root'),
    leaf('a', 'left'), leaf('b', 'left', ['a']), leaf('c', 'right', ['a']), leaf('d', 'right')]));
  const run = { nodes: { root: { state: 'executing' }, left: { state: 'executing' }, right: { state: 'executing' },
    a: { state: 'tests_passed', artifactId: 'A' }, b: { state: 'approved' }, c: { state: 'approved' }, d: { state: 'approved' } } };
  assert.deepEqual(readyWork(draft, run).leaves.map((job) => job.node.id), ['b', 'd']);
  run.nodes.b = { state: 'tests_passed', artifactId: 'B' };
  invalidate(run, [{ id: 'A', dependencyArtifacts: [] }, { id: 'B', dependencyArtifacts: ['A'] }], ['A']);
  assert.equal(run.nodes.b.state, 'invalidated');
  assert.equal(run.nodes.d.state, 'approved');
});

test('independent work completes during a review outage, cross-branch work waits and resumes', async (t) => {
  const options = { approve: false, ready: false };
  const adapter = reviewer(options);
  const f = fixture(t, plan([branch('root'), branch('left', 'root'), branch('right', 'root'),
    leaf('upstream', 'left'), leaf('dependent', 'right', ['upstream']), leaf('independent', 'right')]), { reviewer: adapter });
  const waiting = await f.until((run) => run.nodes.left.state === 'tests_passed' && run.nodes.independent.state === 'tests_passed');
  assert.equal(waiting.nodes.dependent.state, 'approved');
  assert.equal(waiting.budget.reviews, 0);
  assert.deepEqual(f.execution.jobs[0].nodeIds, ['upstream', 'independent']);
  options.ready = true;
  await f.until((run) => run.nodes.upstream.state === 'reviewing' && adapter.requests.length === 1);
  assert.equal(f.state().nodes.dependent.state, 'approved');
  options.approve = true;
  const final = await f.until((run) => run.status === 'accepted');
  assert.equal(final.budget.attempts, 3);
  assert.equal(final.nodes.dependent.state, 'accepted');
  assert.equal(fs.readFileSync(path.join(final.result.directory, 'upstream.txt'), 'utf8'), 'upstream');
  assert.equal(fs.readFileSync(path.join(final.result.directory, 'dependent.txt'), 'utf8'), 'dependent');
});

test('pause keeps completed evidence; restart replays the review without rerunning the executor', async (t) => {
  const adapter = reviewer();
  const f = fixture(t, plan([leaf('one')]), { reviewer: adapter });
  await f.until(() => adapter.requests.length === 1);
  f.command('pause');
  f.reopen();
  const request = adapter.requests[0];
  adapter.results.set(request.requestId, { status: 'done', result: response(request) });
  const final = await f.until((run) => run.status === 'accepted');
  assert.equal(f.execution.jobs.length, 1);
  assert.equal(final.result.reviewId, request.requestId);
  assert.equal(final.budget.reviews, 1);
});

test('restart adopts an already-dispatched operation and imports its durable outcome once', async (t) => {
  const execution = fakeExecution();
  let finish;
  execution.runBatch = (job) => {
    execution.jobs.push(job);
    return new Promise((resolve) => {
      finish = () => resolve({ status: 'done', outcomes: job.nodes.map((node) => successful(job, node)) });
    });
  };
  const f = fixture(t, plan([leaf('one')]), { execution });
  await f.until(() => Boolean(finish));
  f.reopen();
  f.runner.tick();
  assert.equal(f.execution.jobs.length, 1);
  finish();
  const final = await f.until((run) => run.status === 'accepted');
  assert.equal(final.budget.attempts, 1);
  assert.equal(f.execution.jobs.length, 1);
});

test('source edits prevent accepting a result with the old snapshot', async (t) => {
  const adapter = reviewer();
  const f = fixture(t, plan([leaf('one')]), { reviewer: adapter });
  await f.until(() => adapter.requests.length === 1);
  fs.writeFileSync(path.join(f.source, 'initial.txt'), 'local edit');
  const request = adapter.requests[0];
  adapter.results.set(request.requestId, { status: 'done', result: response(request) });
  await f.until((run) => run.status === 'attention');
  assert.equal(f.state().result, undefined);
  assert.equal(fs.readFileSync(path.join(f.source, 'initial.txt'), 'utf8'), 'local edit');
});

test('generated draft runs through integration using real isolated verification commands', async (t) => {
  const execution = fakeExecution();
  execution.checks = createExecution().checks;
  const f = fixture(t, { action: 'plan.draft', ...plan(undefined), integration: { checks, criteria },
    groups: { api: { title: 'API', checks, criteria } }, work: [{ ...leaf('one'), group: 'api' }, leaf('two', null, ['one'])] }, { execution });
  const result = await f.until((run) => run.status === 'accepted');
  assert.equal(result.nodes['group-api'].state, 'accepted');
  assert.equal(result.budget.checks, 4);
});

test('recursive executor consumes an E Verified Batch manifest through real assemble and verify', async (t) => {
  const execution = createExecution({ client: { attempt: () => ({ state: 'stopped' }) }, async runProcess(executable, args, options) {
    if (args[1] !== 'batch') return localProcess(executable, args, options);
    const [, , source, planFile] = args;
    const spec = JSON.parse(fs.readFileSync(planFile, 'utf8')).workers[0];
    assert.equal(spec.model, MODEL);
    assert.match(spec.prompt, /Write the file/);
    const run = fs.mkdtempSync(path.join(options.cwd, 'run-'));
    const baselineHashes = inventory(source);
    const baseline = fs.mkdirSync(path.join(run, 'baseline'), { recursive: true });
    copyVerified(source, baseline, baselineHashes);
    const workerPath = fs.mkdirSync(path.join(run, spec.name), { recursive: true });
    copyVerified(source, workerPath, baselineHashes);
    fs.writeFileSync(path.join(workerPath, spec.writeScope[0]), 'E verified fixture');
    const changedPaths = compareTrees(baseline, workerPath, source);
    const diff = path.join(run, spec.name + '.diff');
    fs.writeFileSync(diff, '+ E verified fixture');
    fs.writeFileSync(path.join(options.cwd, 'managed-run.json'), JSON.stringify({ run, source }));
    fs.writeFileSync(path.join(run, 'manifest.json'), JSON.stringify({ run, source, baseline, baselineHashes,
      workers: { [spec.name]: workerPath } }));
    fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({ run, finishedAt: new Date().toISOString(), workers: [{
      name: spec.name, diff, status: 'completed', model: spec.model, workerPath, writeScope: spec.writeScope,
      verification: { verified: true }, changedPaths, artifactHashes: artifactHashes(workerPath, changedPaths),
    }] }));
    return { code: 0, closed: true, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } });
  const f = fixture(t, plan([leaf('one')]), { execution });
  const result = await f.until((run) => run.status === 'accepted');
  assert.equal(fs.readFileSync(path.join(result.result.directory, 'one.txt'), 'utf8'), 'E verified fixture');
  assert.match(f.store.recursive.attempts(f.runId)[0].runId, /run-/);
});

test('24-level tree completes including every branch verification', async (t) => {
  const nodes = Array.from({ length: 23 }, (_, n) => branch('branch-' + n, n ? 'branch-' + (n - 1) : null));
  nodes.push(leaf('end', 'branch-22'));
  const f = fixture(t, plan(nodes));
  const result = await f.until((run) => run.status === 'accepted');
  assert.equal(result.budget.checks, 24);
  assert.equal(result.budget.attempts, 1);
  assert.equal(result.budget.reviews, 1);
  assert.ok(Object.values(result.nodes).every((node) => node.state === 'accepted'));
});

test('active chat reviews separately pinned branch requests across restart, without a broker', async (t) => {
  const f = fixture(t, plan([branch('root'), branch('api', 'root'), leaf('schema', 'api'),
    leaf('client', 'root', ['api']), leaf('docs', 'root')]), { reviewer: null });
  const scope = { projectId: f.project.id, runId: f.runId };
  const pending = () => f.runner.sessionReview(scope, 'cli').pending;
  const submit = (request) => f.runner.sessionReview({ ...scope, ...response(request) }, 'cli', true);
  await f.until((run) => pending().length === 1 && run.nodes.docs.state === 'tests_passed');
  const first = pending()[0];
  assert.equal(first.nodeId, 'api');
  assert.equal(f.state().nodes.client.state, 'approved');
  assert.ok(first.diff.includes('schema'));
  assert.throws(() => submit({ ...first, assemblyHash: fingerprint('different') }), { code: 'review.result' });
  assert.throws(() => f.runner.sessionReview(scope, 'browser'), { code: 'cli_required' });
  f.reopen();
  assert.equal(pending()[0].requestId, first.requestId);
  submit(first);
  assert.throws(() => submit(first), { code: 'review.stale' });
  await f.until(() => pending()[0]?.nodeId === 'root');
  submit(pending()[0]);
  const accepted = await f.until((run) => run.status === 'accepted');
  assert.equal(accepted.budget.reviews, 2);
  assert.equal(fs.readFileSync(path.join(accepted.result.directory, 'client.txt'), 'utf8'), 'client');
});

test('rejecting a provisional source invalidates completed consumers and keeps independent evidence', async (t) => {
  const adapter = reviewer();
  const f = fixture(t, plan([branch('root'), branch('left', 'root'), branch('right', 'root'),
    leaf('a', 'left'), leaf('b', 'left', ['a']), leaf('remote', 'right', ['a']), leaf('good', 'right')]), { reviewer: adapter });
  await f.until((run) => run.nodes.b.state === 'tests_passed' && adapter.requests.length === 1);
  const request = adapter.requests[0];
  assert.equal(f.state().nodes.b.provisionalInputs.length, 1);
  adapter.results.set(request.requestId, { status: 'done', result: response(request, 'rejected') });
  const after = await f.until((run) => run.nodes.a.state === 'rejected');
  assert.equal(after.nodes.b.state, 'invalidated');
  assert.equal(after.nodes.good.state, 'tests_passed');
  assert.equal(after.nodes.remote.state, 'approved');
});

test('limits stay consumed through a revision and the unchanged artifact is reused', async (t) => {
  const execution = fakeExecution();
  execution.runBatch = async (job) => {
    execution.jobs.push(job);
    return { status: 'done', outcomes: job.nodes.map((node) => node.id === 'two'
      ? { nodeId: node.id, status: 'failed', reason: 'intentional failure' } : successful(job, node)) };
  };
  const options = { approve: false, ready: false };
  const nodes = [branch('root'), leaf('one', 'root'), leaf('two', 'root')];
  const f = fixture(t, plan(nodes, { attempts: 2 }), { execution, reviewer: reviewer(options) });
  const first = await f.until((run) => run.nodes.two.state === 'failed');
  const artifact = first.nodes.one.artifactId;
  const revised = plan(nodes.map((node) => node.id === 'two' ? { ...node, goal: 'Fix the failed file' } : node), { attempts: 2 });
  assert.equal(f.runner.revise({ projectId: f.project.id, runId: f.runId, revision: first.revision, plan: revised }, 'cli').revision, 2);
  const blocked = await f.until((run) => run.status === 'budget_exhausted');
  assert.equal(blocked.budget.attempts, 2);
  assert.equal(blocked.nodes.one.artifactId, artifact);
  assert.equal(execution.jobs.length, 1);
});

test('automatic replan uses the approved scope and succeeds with the remaining budget', async (t) => {
  const execution = fakeExecution();
  let count = 0;
  const draft = plan([leaf('one')]);
  const revised = plan([{ ...leaf('one'), goal: 'Repair the text file after the failed assertion' }]);
  const originalBatch = execution.runBatch;
  execution.runBatch = (job) => {
    if (++count === 1) return { status: 'failed', reason: 'original assertion failed' };
    return originalBatch(job);
  };
  const adapter = reviewer();
  const poll = adapter.poll.bind(adapter);
  adapter.poll = (request) => request.kind === 'replan'
    ? { status: 'done', result: { ...response(request), proposal: JSON.stringify(revised) } }
    : poll(request);
  const f = fixture(t, draft, { execution, reviewer: adapter });
  await f.until(() => adapter.requests.some((request) => request.kind === 'review'));
  const request = adapter.requests.find((item) => item.kind === 'review');
  adapter.results.set(request.requestId, { status: 'done', result: response(request) });
  const final = await f.until((run) => run.status === 'accepted');
  assert.equal(final.revision, 2);
  assert.equal(final.budget.attempts, 2);
  assert.equal(final.budget.replans, 1);
  assert.equal(count, 2);
});

test('reported token budget blocks the next invocation', async (t) => {
  const execution = fakeExecution();
  const batch = execution.runBatch;
  execution.runBatch = async (job) => ({ ...await batch(job), usage: { tokens: 10, costMicros: 0 } });
  const f = fixture(t, plan([leaf('one')], { tokens: 10 }), { execution });
  const final = await f.until((run) => run.status === 'budget_exhausted');
  assert.equal(final.budget.tokens, 10);
  assert.equal(final.budget.reviews, 0);
  assert.equal(f.adapter.requests.length, 0);
});

test('cancel stays pending until the owned attempt confirms that sessions are stopped', async (t) => {
  const execution = fakeExecution();
  let end;
  let isStopped = false;
  let cancellations = 0;
  execution.runBatch = (job) => {
    execution.jobs.push(job);
    return new Promise((resolve) => { end = resolve; });
  };
  execution.cancel = () => { cancellations++; return { state: isStopped ? 'stopped' : 'unknown' }; };
  const f = fixture(t, plan([leaf('one')]), { execution });
  await f.until(() => Boolean(end));
  f.command('cancel');
  await f.until(() => cancellations > 0);
  assert.equal(f.state().status, 'cancelling');
  isStopped = true;
  end({ status: 'failed', reason: 'owned session stopped' });
  const stopped = await f.until((run) => run.status === 'cancelled');
  assert.equal(stopped.nodes.one.artifactId, undefined);
  assert.equal(execution.jobs.length, 1);
});

test('broker requires opt-in and replays authenticated terminal evidence without a new process', async (t) => {
  const { storage } = folders(t);
  fs.mkdirSync(path.join(storage, 'inbox'));
  fs.mkdirSync(path.join(storage, 'results'));
  const config = { enabled: true, allowCodex: true, spoolDir: storage, reviewerSid: 'S-1-5-21-1', controllerSid: 'S-1-5-21-2',
    codexHome: path.join(storage, 'home'), codexPath: 'mock-only' };
  const request = { requestId: 'request-1', authorized: true, kind: 'review', assemblyHash: evidenceHash,
    verificationHash: evidenceHash, deadline: Date.now() + 30000, criteria, diff: '+ evidence', testLogs: 'passed' };
  let calls = 0;
  const deps = { protect() {}, probeReadonly() {}, probeDirectoryReadonly() {}, async runProcess(_exe, args, options) {
    calls++;
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('mcp_servers={}'));
    assert.match(options.input, /untrusted data/);
    return { closed: true, code: 0, stdout: Buffer.from([
      { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response(request)) } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n')), stderr: Buffer.alloc(0) };
  } };
  await assert.rejects(runBroker({ ...config, allowCodex: false }, deps), { code: 'review.permission' });
  await runBroker(config, deps);
  const queue = createReviewQueue(config, { controller() {} });
  queue.enqueue(request);
  await runBroker(config, deps);
  assert.equal(queue.poll(request).status, 'done');
  const terminal = path.join(storage, 'results', packet(request).key, 'terminal.json');
  fs.unlinkSync(terminal);
  await runBroker(config, deps);
  assert.equal(queue.poll(request).result.requestId, request.requestId);
  assert.equal(calls, 1);
});

test('OpenCode 2.3.0 contract interrupts owned sessions and cancels queued turns', () => {
  const dir = path.resolve('mock-worktree');
  const parent = { id: 'ses_parent', location: { directory: dir }, outcome: 'active' };
  const child = { id: 'ses_child', parentID: parent.id, location: parent.location, outcome: 'active' };
  const calls = [];
  const spec = { paths: {} };
  for (const [route, method, operationId] of API) {
    spec.paths[route] ??= {};
    spec.paths[route][method] = { operationId, parameters: [{ name: 'resume' }] };
  }
  let queued = true;
  const client = createOpenCodeClient({ binary: 'mock-only', spawnSync(_exe, args) {
    const ok = (value) => ({ status: 0, stdout: typeof value === 'string' ? value : JSON.stringify(value) });
    if (args[0] === '--version') return ok('opencode v' + VERSION);
    if (args[0] === 'service') return ok('http://127.0.0.1:12345');
    const operation = args[1];
    const id = args.find((arg) => arg.startsWith('sessionID='))?.split('=')[1];
    if (operation === 'GET') return ok(spec);
    calls.push([operation, id, ...args.slice(2)]);
    if (operation === 'session.get') return ok({ data: id === parent.id ? parent : child });
    if (operation === 'session.list') return ok({ data: [child] });
    if (operation === 'session.active') return ok({ data: parent.outcome === 'active' ? { [parent.id]: {} } : {} });
    if (operation === 'session.inbox.list') return ok({ data: queued && id === child.id ? [{ id: 'inbox1' }] : [] });
    if (operation === 'session.inbox.cancel') queued = false;
    if (operation === 'session.interrupt') {
      assert.ok(args.includes('resume=false'));
      (id === parent.id ? parent : child).outcome = 'interrupted';
    }
    return ok({ data: {} });
  } });
  const owner = { id: parent.id, directory: dir };
  assert.equal(client.state(owner).state, 'unknown');
  assert.equal(client.state(owner, { cancel: true }).state, 'stopped');
  assert.ok(calls.some(([op, id]) => op === 'session.inbox.cancel' && id === child.id));
});
