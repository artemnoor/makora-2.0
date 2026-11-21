'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { samePath, inside, realDirectory } = require('./artifacts.cjs');
const { requirePlan } = require('./plan.cjs');

const VERSION = '2.3.0';
const SESSION = /^ses_[a-zA-Z0-9_]+$/;
const API = [
  ['/api/session', 'post', 'session.create'],
  ['/api/session', 'get', 'session.list'],
  ['/api/session/{sessionID}', 'get', 'session.get'],
  ['/api/session/active', 'get', 'session.active'],
  ['/api/session/{sessionID}/interrupt', 'post', 'session.interrupt'],
  ['/api/session/{sessionID}/inbox', 'get', 'session.inbox.list'],
  ['/api/session/{sessionID}/inbox/{inboxID}', 'delete', 'session.inbox.cancel'],
];

function cliPath() {
  return path.join(process.env.APPDATA || '', 'ai.opencode.desktop', 'cli', VERSION + '-x64', 'opencode-cli.exe');
}

function location(info, directory) {
  return typeof info?.location?.directory === 'string' && samePath(path.resolve(info.location.directory), directory);
}

function validModel(value) {
  return typeof value === 'string' && /^opencode\/[a-z0-9._-]+$/i.test(value);
}

function createOpenCodeClient(options = {}) {
  const binary = options.binary ?? cliPath();
  const spawn = options.spawnSync ?? spawnSync;
  let checked = false;
  function invoke(args, cwd) {
    const result = spawn(binary, args, { cwd, encoding: 'utf8', shell: false, windowsHide: true,
      timeout: 12000, maxBuffer: 8 * 1024 * 1024, env: process.env });
    requirePlan(!result.error && result.status === 0, 'opencode.unavailable', 'Локальный OpenCode не ответил: ' +
      String(result.error?.message ?? result.stderr ?? '').trim().slice(0, 260));
    return result.stdout.trim().replace(/^\uFEFF/, '');
  }
  function api(operation, parameters = {}, body = undefined, cwd = undefined) {
    const args = ['api', operation];
    for (const [name, value] of Object.entries(parameters)) args.push('--param', name + '=' + value);
    if (body !== undefined) args.push('--data', JSON.stringify(body));
    return JSON.parse(invoke(args, cwd));
  }
  function preflight(cwd) {
    if (checked) return;
    requirePlan(invoke(['--version'], cwd) === 'opencode v' + VERSION, 'opencode.version', 'Управляемый режим требует OpenCode ' + VERSION + '.');
    const address = invoke(['service', 'status'], cwd);
    requirePlan(/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(address), 'opencode.loopback', 'OpenCode должен работать локально.');
    const spec = JSON.parse(invoke(['api', 'GET', '/openapi.json'], cwd));
    requirePlan(API.every(([route, method, operation]) => spec.paths?.[route]?.[method]?.operationId === operation) &&
      spec.paths['/api/session/{sessionID}/interrupt'].post.parameters?.some((param) => param.name === 'resume'),
    'opencode.contract', 'Изменился локальный контракт управления сессиями.');
    checked = true;
  }
  function get(id, directory) {
    requirePlan(SESSION.test(id), 'opencode.session', 'Недопустимый ID сессии.');
    const result = api('session.get', { sessionID: id }, undefined, directory).data;
    requirePlan(result?.id === id && location(result, directory), 'opencode.ownership', 'Сессия находится вне рабочей копии.');
    return result;
  }
  function children(owner) {
    const result = api('session.list', { parentID: owner.id, limit: 100 }, undefined, owner.directory);
    requirePlan(Array.isArray(result.data) && !result.cursor?.next, 'opencode.unknown', 'Неполный список дочерних сессий.');
    for (const child of result.data) {
      requirePlan(SESSION.test(child.id) && child.parentID === owner.id && location(child, owner.directory),
        'opencode.ownership', 'Связь с дочерней сессией не подтверждена.');
    }
    return result.data;
  }
  function reserve(directory, model, ownerFile) {
    preflight(directory);
    requirePlan(validModel(model), 'opencode.model', 'Модель OpenCode не согласована.');
    const owner = { id: 'ses_makora_' + randomUUID().replaceAll('-', ''), directory, model };
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx' });
    const result = api('session.create', {}, {
      id: owner.id, title: 'Makora ' + path.basename(directory), agent: 'build', model: {
        providerID: 'opencode', id: model.split('/')[1], variant: 'default',
      }, location: { directory },
    }, directory).data;
    requirePlan(result?.id === owner.id && !result.parentID && location(result, directory) &&
      result.model?.providerID === 'opencode' && result.model?.id === model.split('/')[1],
    'opencode.ownership', 'OpenCode не подтвердил резервирование сессии и модели.');
    return owner;
  }
  function state(owner, { cancel = false } = {}) {
    preflight(owner.directory);
    const parent = get(owner.id, owner.directory);
    requirePlan(!parent.parentID, 'opencode.ownership', 'Корневая сессия изменилась.');
    const known = [parent, ...children(owner)];
    if (cancel) {
      for (const item of known) {
        const inbox = api('session.inbox.list', { sessionID: item.id }, undefined, owner.directory).data;
        requirePlan(Array.isArray(inbox), 'opencode.unknown', 'Не удалось прочитать очередь сессии.');
        for (const queued of inbox) {
          requirePlan(typeof queued.id === 'string' && /^[A-Za-z0-9_-]+$/.test(queued.id), 'opencode.unknown', 'Недопустимый ID ввода.');
          api('session.inbox.cancel', { sessionID: item.id, inboxID: queued.id }, undefined, owner.directory);
        }
        api('session.interrupt', { sessionID: item.id, resume: false }, undefined, owner.directory);
      }
      api('session.interrupt', { sessionID: owner.id, resume: false }, undefined, owner.directory);
    }
    const active = api('session.active', {}, undefined, owner.directory).data;
    requirePlan(active && typeof active === 'object' && !Array.isArray(active), 'opencode.unknown', 'Не подтверждён список активных сессий.');
    const latest = [get(owner.id, owner.directory), ...children(owner)];
    const busy = latest.some((item) => {
      const input = api('session.inbox.list', { sessionID: item.id }, undefined, owner.directory).data;
      requirePlan(Array.isArray(input), 'opencode.unknown', 'Не подтверждена очередь сессии.');
      return Object.hasOwn(active, item.id) || input.length || !['succeeded', 'failed', 'interrupted'].includes(item.outcome);
    });
    return { state: busy ? 'unknown' : 'stopped', sessions: latest.map(({ id, parentID, outcome }) => ({ id, parentID, outcome })) };
  }

  function attempt(directory, { cancel = false, allowUndispatched = false } = {}) {
    const root = realDirectory(directory);
    const marker = path.join(root, 'managed-run.json');
    if (!fs.existsSync(marker)) return { state: 'unknown' };
    const run = realDirectory(JSON.parse(fs.readFileSync(marker, 'utf8')).run);
    requirePlan(inside(root, run), 'opencode.ownership', 'Манифест находится вне попытки.');
    const manifest = JSON.parse(fs.readFileSync(path.join(run, 'manifest.json'), 'utf8'));
    const states = [];
    for (const [name, dir] of Object.entries(manifest.workers)) {
      requirePlan(/^[a-z][a-z0-9-]{0,39}$/.test(name), 'opencode.ownership', 'Недопустимое имя исполнителя.');
      const file = path.join(run, name + '.ownership.json');
      if (!fs.existsSync(file)) {
        states.push({ state: allowUndispatched ? 'stopped' : 'unknown' });
        continue;
      }
      requirePlan(fs.lstatSync(file).isFile(), 'opencode.ownership', 'Недопустимый файл владения.');
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      const workerDirectory = realDirectory(dir);
      requirePlan(inside(run, workerDirectory) && samePath(owner.directory, workerDirectory), 'opencode.ownership', 'Не подтверждена рабочая копия.');
      states.push(state(owner, { cancel }));
    }
    return { state: states.length && states.every((entry) => entry.state === 'stopped') ? 'stopped' : 'unknown',
      sessions: states.flatMap((entry) => entry.sessions ?? []) };
  }
  return { preflight, reserve, state, attempt, binary };
}

module.exports = { VERSION, API, SESSION, validModel, createOpenCodeClient };
