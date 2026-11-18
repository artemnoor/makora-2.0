'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const http = require('node:http');
const { crc32 } = require('node:zlib');
const { createDashboard } = require('./server.cjs');

function zip(entries) {
  const data = [];
  const directory = [];
  let offset = 0;
  for (const [filename, contents, mode = 0o100644] of entries) {
    const name = Buffer.from(filename);
    const bytes = Buffer.from(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    local.copy(central, 16, 14, 26);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    data.push(local, name, bytes);
    directory.push(central, name);
    offset += local.length + name.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.reduce((size, part) => size + part.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...data, ...directory, end]);
}

const contract = {
  openapi: '3.1.0',
  info: { title: 'Counter', version: '1.0.0' },
  paths: { '/count': { get: { responses: { 200: { description: 'Count' } } } } },
};

const httpModule = `module.exports = (_request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ count: 42 }));
};\n`;

function archiveEntries(brief) {
  return [
    ['outsource.json', JSON.stringify(brief.returnZip['outsource.json'])],
    ['openapi.json', JSON.stringify({ paths: brief.openapi.paths, info: brief.openapi.info, openapi: brief.openapi.openapi })],
    ['module/index.cjs', httpModule],
    ['module/README.md', '# Counter\n'],
  ];
}

async function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'makora-outsource-test-'));
  const options = { port: 0, dataDir: path.join(temp, 'data'), logger() {}, observer: { observe: () => [] } };
  let dashboard;
  let url;
  async function start() {
    dashboard = createDashboard(options);
    await dashboard.listen();
    url = 'http://127.0.0.1:' + dashboard.port;
  }
  t.after(async () => {
    await dashboard.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await start();
  async function action(payload, expected = 200) {
    const response = await fetch(url + '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function project(name) {
    const directory = path.join(temp, name);
    fs.mkdirSync(path.join(directory, 'modules'), { recursive: true });
    const { projectId } = await action({ action: 'project.add', name, path: directory });
    return { projectId, directory };
  }
  async function create(projectId, changes = {}, expected = 200) {
    return action({
      action: 'outsource.create', projectId, title: 'Counter',
      goal: 'Return a count', context: 'Synthetic inputs', boundaries: 'HTTP only',
      targetPath: 'modules/counter', criteria: ['GET /count returns count'], openapi: contract,
      ...changes,
    }, expected);
  }
  function resource(projectId, id, name) {
    return url + '/api/outsources/' + projectId + '/' + id + '/' + name;
  }
  async function upload(projectId, id, entries, expected = 200) {
    const response = await fetch(resource(projectId, id, 'archive'), {
      method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip(entries),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function state(projectId) {
    const response = await fetch(url + '/api/state');
    return (await response.json()).projects.find((item) => item.id === projectId);
  }
  return {
    project, create, action, resource, upload, state,
    restart: async () => { await dashboard.close(); await start(); },
  };
}

test('аутсорс: ТЗ и OpenAPI, импорт, приёмка и вызов API из интегрированного модуля', async (t) => {
  const f = await fixture(t);
  const { projectId, directory } = await f.project('app');
  const other = await f.project('other');
  const created = await f.create(projectId);
  const { id } = created.outsource;
  assert.equal(created.outsource.state, 'prepared');

  const response = await fetch(f.resource(projectId, id, 'brief'));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const brief = await response.json();
  assert.equal(brief.schemaVersion, 1);
  assert.equal(brief.outsourceId, id);
  assert.equal(brief.targetPath, undefined);
  assert.ok(!JSON.stringify(brief).includes(directory));
  assert.deepEqual(brief.openapi, contract);

  const apiResponse = await fetch(f.resource(projectId, id, 'contract'));
  assert.deepEqual(await apiResponse.json(), contract);
  assert.equal((await fetch(f.resource(other.projectId, id, 'brief'))).status, 404);

  const entries = archiveEntries(brief);
  const imported = await f.upload(projectId, id, entries);
  assert.equal(imported.outsource.state, 'imported');
  const { sha256, location } = imported.outsource.artifact;
  assert.equal(fs.readFileSync(path.join(location, 'module/index.cjs'), 'utf8'), httpModule);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'modules')), []);
  assert.equal((await f.upload(projectId, id, entries)).idempotent, true);

  const payload = { action: 'outsource.accept', projectId, id, sha256, evidence: 'Проверены файлы и команды запуска.' };
  assert.equal((await f.action({ ...payload, sha256: 'old' }, 409)).code, 'outsource.digest_mismatch');
  assert.equal((await f.action({ ...payload, projectId: other.projectId }, 404)).code, 'outsource.not_found');
  const integrate = { action: 'outsource.integrate', projectId, id, sha256 };
  assert.equal((await f.action(integrate, 409)).code, 'outsource.state');
  assert.equal((await f.action(payload)).outsource.state, 'accepted');

  await f.restart();
  assert.equal((await f.state(projectId)).outsources[0].state, 'accepted');
  assert.equal((await f.action(integrate)).outsource.state, 'integrated');
  assert.equal((await f.action(integrate)).idempotent, true);
  const target = path.join(directory, 'modules/counter');
  assert.deepEqual(fs.readdirSync(target).sort(), ['module', 'openapi.json']);
  const moduleServer = http.createServer(require(path.join(target, 'module/index.cjs')));
  t.after(() => new Promise((resolve) => moduleServer.close(resolve)));
  await new Promise((resolve) => moduleServer.listen(0, '127.0.0.1', resolve));
  const count = await fetch('http://127.0.0.1:' + moduleServer.address().port + '/count');
  assert.equal(count.status, 200);
  assert.deepEqual(await count.json(), { count: 42 });
  assert.deepEqual((await f.state(other.projectId)).outsources, []);
});

test('аутсорс: отклоняет неподходящие архивы, изменённые файлы и занятый каталог', async (t) => {
  const f = await fixture(t);
  const { projectId, directory } = await f.project('app');
  assert.equal((await f.create(projectId, { targetPath: '.git/module' }, 400)).code, 'outsource.invalid_path');
  const { id } = (await f.create(projectId)).outsource;
  const brief = await (await fetch(f.resource(projectId, id, 'brief'))).json();
  const entries = archiveEntries(brief);
  const badManifest = { ...brief.returnZip['outsource.json'], contractVersion: '2.0' };
  assert.equal((await f.upload(projectId, id, [['outsource.json', JSON.stringify(badManifest)], ...entries.slice(1)], 409)).code,
    'outsource.manifest_mismatch');
  const changed = { ...contract, info: { ...contract.info, description: 'Different' } };
  assert.equal((await f.upload(projectId, id, [entries[0], ['openapi.json', JSON.stringify(changed)], ...entries.slice(2)], 409)).code,
    'outsource.contract_mismatch');
  for (const invalid of [
    ['module/../elsewhere', 'bad'],
    ['module/INDEX.cjs', 'conflict'],
    ['module/link', 'bad', 0o120777],
    ['module/aux.txt', 'bad'],
  ]) {
    await f.upload(projectId, id, [...entries, invalid], 400);
  }
  assert.equal((await f.state(projectId)).outsources[0].state, 'prepared');
  const { artifact } = (await f.upload(projectId, id, entries)).outsource;
  const action = { projectId, id, sha256: artifact.sha256 };
  await f.action({ ...action, action: 'outsource.accept', evidence: 'Review completed' });
  const integrate = { ...action, action: 'outsource.integrate' };
  fs.writeFileSync(path.join(artifact.location, 'module/README.md'), 'tampered');
  assert.equal((await f.action(integrate, 409)).code, 'outsource.artifact_changed');
  const target = path.join(directory, 'modules/counter');
  assert.equal(fs.existsSync(target), false);
  assert.equal((await f.upload(projectId, id, entries)).outsource.state, 'accepted');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep');
  assert.equal((await f.action(integrate, 409)).code, 'outsource.target_exists');
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep');
  assert.equal((await f.state(projectId)).outsources[0].state, 'accepted');
  fs.renameSync(target, path.join(directory, 'modules/previous'));
  await f.action(integrate);
  assert.equal(fs.readFileSync(path.join(target, 'module/README.md'), 'utf8'), '# Counter\n');
});

test('аутсорс: новая ревизия требует новой приёмки, переход восстанавливается после перезапуска', async (t) => {
  const f = await fixture(t);
  const { projectId, directory } = await f.project('app');
  const { id } = (await f.create(projectId)).outsource;
  const brief = await (await fetch(f.resource(projectId, id, 'brief'))).json();
  const entries = archiveEntries(brief);
  const first = (await f.upload(projectId, id, entries)).outsource.artifact;
  const replacement = [...entries.slice(0, -1), ['module/README.md', 'Revision two']];
  const second = (await f.upload(projectId, id, replacement)).outsource.artifact;
  assert.notEqual(first.sha256, second.sha256);
  const accept = { action: 'outsource.accept', projectId, id, evidence: 'Revision reviewed.' };
  assert.equal((await f.action({ ...accept, sha256: first.sha256 }, 409)).code, 'outsource.digest_mismatch');
  await f.action({ ...accept, sha256: second.sha256 });
  assert.equal((await f.upload(projectId, id, entries, 409)).code, 'outsource.state');

  const target = path.join(directory, 'modules/counter');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, '.makora-outsource'), id + '\n' + second.sha256 + '\n');
  fs.copyFileSync(path.join(second.location, 'openapi.json'), path.join(target, 'openapi.json'));
  await f.restart();
  await f.action({ action: 'outsource.integrate', projectId, id, sha256: second.sha256 });
  assert.equal(fs.readFileSync(path.join(target, 'module/README.md'), 'utf8'), 'Revision two');
  assert.equal(fs.existsSync(path.join(target, '.makora-outsource')), false);
});

test('аутсорс: интеграция отклоняет каталог за ссылкой и покидает проект без правок', async (t) => {
  const f = await fixture(t);
  const { projectId, directory } = await f.project('app');
  const other = await f.project('other');
  fs.symlinkSync(other.directory, path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const { id } = (await f.create(projectId, { targetPath: 'alias/modules/counter' })).outsource;
  const brief = await (await fetch(f.resource(projectId, id, 'brief'))).json();
  const { artifact } = (await f.upload(projectId, id, archiveEntries(brief))).outsource;
  const payload = { projectId, id, sha256: artifact.sha256 };
  await f.action({ ...payload, action: 'outsource.accept', evidence: 'Reviewed.' });
  const refused = await f.action({ ...payload, action: 'outsource.integrate' }, 409);
  assert.equal(refused.code, 'outsource.unsafe_directory');
  assert.deepEqual(fs.readdirSync(path.join(other.directory, 'modules')), []);
});
