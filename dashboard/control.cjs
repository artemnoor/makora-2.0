'use strict';

// Клиент дашборда. Все команды работают только с локальным сервером 127.0.0.1.
// compile не выполняет сетевых запросов.

const fs = require('node:fs');
const path = require('node:path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 18741;
const REQUIRED_FIELDS = ['goal', 'context', 'contract', 'writeScope', 'criteria', 'report'];
const profilesDir = path.join(__dirname, 'profiles');

const USAGE = [
  'Использование:',
  '  node dashboard/control.cjs [--port N] state [projectId]',
  '  node dashboard/control.cjs [--port N] action <json-file>',
  '  node dashboard/control.cjs [--port N] idea <project-id> <text>',
  '  node dashboard/control.cjs compile <profile> <ticket-json>',
  '',
  'Порт по умолчанию: ' + DEFAULT_PORT + ' (только 127.0.0.1).',
  'Переопределение: --port N, DASHBOARD_PORT или OPENCODE_DASHBOARD_PORT.',
  'compile работает без сети и печатает JSON с полями profile, version, prompt, ticket.',
].join('\n');

function debug(message) {
  if (process.env.LOG_LEVEL === 'debug') {
    process.stderr.write('[control] ' + message + '\n');
  }
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePort(value) {
  const raw = text(value);
  if (!raw || !/^\d+$/.test(raw)) throw new Error('Некорректный локальный порт: ' + value);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Порт должен быть числом от 1 до 65535: ' + value);
  }
  return port;
}

function envPort() {
  const configured = text(process.env.DASHBOARD_PORT) ?? text(process.env.OPENCODE_DASHBOARD_PORT);
  return configured === null ? DEFAULT_PORT : parsePort(configured);
}

function parseArgs(argv) {
  let port = null;
  let command = null;
  const args = [];
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === '--port') {
      port = parsePort(argv[++index]);
    } else if (token.startsWith('--port=')) {
      port = parsePort(token.slice('--port='.length));
    } else if (token === '--help' || token === '-h') {
      command = 'help';
    } else if (command === null) {
      command = token;
    } else {
      args.push(token);
    }
  }
  return { port: port ?? envPort(), command, args };
}

function readJsonInput(input) {
  let raw = input;
  try {
    if (fs.existsSync(input)) raw = fs.readFileSync(input, 'utf8');
  } catch {
    // considered inline JSON below
  }
  raw = String(raw).replace(/^\uFEFF/, '');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('ожидался JSON-объект');
    }
    return value;
  } catch (error) {
    throw new Error('Некорректный JSON: ' + (error && error.message ? error.message : input));
  }
}

function parseFrontmatter(content) {
  const normalized = String(content).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: normalized };
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) return { data: {}, body: normalized };
  const header = normalized.slice(4, end);
  const body = normalized.slice(end + '\n---\n'.length);
  const data = {};
  for (const line of header.split('\n')) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1).split(',').map((item) =>
          item.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      }
    } else if ((value.startsWith('"') && value.endsWith('"')) ||
               (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[match[1]] = value;
  }
  return { data, body };
}

function loadProfile(selector, options) {
  const dir = path.resolve((options && options.profilesDir) ?? profilesDir);
  let content;
  let sourcePath = null;
  const requested = String(selector ?? '');
  try {
    if (fs.existsSync(requested) && /\.md$/i.test(requested)) {
      sourcePath = path.resolve(requested);
      content = fs.readFileSync(sourcePath, 'utf8');
    }
  } catch {
    // упаковка по имени из каталога профилей
  }
  if (content === undefined) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => /\.md$/i.test(name)).sort();
    } catch {
      throw new Error('Каталог профилей недоступен: ' + dir);
    }
    const wanted = requested.toLowerCase();
    for (const name of names) {
      const candidatePath = path.join(dir, name);
      let candidate;
      try {
        candidate = fs.readFileSync(candidatePath, 'utf8');
      } catch {
        continue; // повреждённый профиль не мешает остальным
      }
      const { data } = parseFrontmatter(candidate);
      const aliases = Array.isArray(data.aliases) ? data.aliases :
        (data.aliases ? [data.aliases] : []);
      const identifiers = [data.id, ...aliases, name,
        name.replace(/\.SKILL\.md$/i, ''), name.replace(/\.md$/i, '')]
        .filter(Boolean).map((value) => String(value).toLowerCase());
      if (identifiers.includes(wanted)) {
        content = candidate;
        sourcePath = candidatePath;
        break;
      }
    }
  }
  if (content === undefined) throw new Error('Профиль не найден: ' + selector);
  const { data, body } = parseFrontmatter(content);
  return {
    id: String(data.id ?? path.basename(sourcePath ?? 'profile.md', '.md')),
    version: String(data.version ?? '0.0.0'),
    role: String(data.role ?? ''),
    path: sourcePath,
    content: body.trim(),
  };
}

function renderValue(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (!value.length) return '';
    return value.map((item) => typeof item === 'string' ?
      '- ' + item : '- ' + JSON.stringify(item)).join('\n');
  }
  if (typeof value === 'object') return '```json\n' + JSON.stringify(value, null, 2) + '\n```';
  return String(value);
}

// Поля тикета переносятся дословно: меняется только упаковка.
function compileTicket(selector, ticket, options) {
  if (!ticket || typeof ticket !== 'object' || Array.isArray(ticket)) {
    throw new Error('Тикет должен быть JSON-объектом');
  }
  const missing = REQUIRED_FIELDS.filter((key) => !Object.prototype.hasOwnProperty.call(ticket, key));
  if (missing.length) throw new Error('В тикете отсутствуют обязательные поля: ' + missing.join(', '));

  const profile = loadProfile(selector, options);
  const preserved = {};
  for (const key of REQUIRED_FIELDS) preserved[key] = ticket[key];
  for (const key of Object.keys(ticket)) {
    if (!REQUIRED_FIELDS.includes(key)) preserved[key] = ticket[key];
  }

  const sections = REQUIRED_FIELDS
    .map((key) => '### ' + key + '\n\n' + renderValue(ticket[key]))
    .join('\n\n');
  const prompt = [
    '# Скомпилированный тикет',
    '',
    'Профиль: ' + profile.id + ' (версия ' + profile.version + ')',
    '',
    '## Инструкции профиля',
    '',
    profile.content,
    '',
    '## Тикет',
    '',
    sections,
    '',
  ].join('\n');

  debug('compiled ' + profile.id + '@' + profile.version);
  return { profile: profile.id, version: profile.version, prompt, ticket: preserved };
}

async function apiRequest(port, method, endpoint, body) {
  const url = 'http://' + HOST + ':' + port + endpoint;
  const options = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json; charset=utf-8';
    options.body = JSON.stringify(body);
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    options.signal = AbortSignal.timeout(15000);
  }
  debug(method + ' ' + url);
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error('Не удалось связаться с дашбордом: ' + (error && error.message ? error.message : error));
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('Дашборд вернул не JSON (HTTP ' + response.status + ')');
  }
  if (!response.ok) throw new Error(text(payload && payload.error) ?? ('HTTP ' + response.status));
  return payload;
}

async function commandState(parsed) {
  const projectId = parsed.args.length ? text(parsed.args[0]) : null;
  if (parsed.args.length > 1 || (parsed.args.length && !projectId)) {
    throw new Error('Использование: state [projectId]');
  }
  const payload = await apiRequest(parsed.port, 'GET', '/api/state');
  if (projectId) {
    if (!Array.isArray(payload.projects)) throw new Error('Дашборд вернул ответ без массива projects');
    const projects = payload.projects.filter((project) => project && project.id === projectId);
    if (!projects.length) throw new Error('Проект не найден: ' + projectId);
    payload.projects = projects;
  }
  return payload;
}

function commandAction(parsed) {
  if (parsed.args.length !== 1 || !text(parsed.args[0])) {
    throw new Error('Использование: action <json-file>');
  }
  const body = readJsonInput(parsed.args[0]);
  return apiRequest(parsed.port, 'POST', '/api/actions', body);
}

function commandIdea(parsed) {
  if (parsed.args.length < 2 || !text(parsed.args[0])) {
    throw new Error('Использование: idea <project-id> <text>');
  }
  const projectId = text(parsed.args[0]);
  const ideaText = parsed.args.slice(1).join(' ').trim();
  if (!ideaText) throw new Error('Текст идеи не может быть пустым');
  return apiRequest(parsed.port, 'POST', '/api/actions', {
    action: 'idea.add', projectId, text: ideaText,
  });
}

function commandCompile(parsed) {
  if (parsed.args.length !== 2) throw new Error('Использование: compile <profile> <ticket-json>');
  return compileTicket(parsed.args[0], readJsonInput(parsed.args[1]));
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.command || parsed.command === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  try {
    let result;
    switch (parsed.command) {
      case 'state': result = await commandState(parsed); break;
      case 'action': result = await commandAction(parsed); break;
      case 'idea': result = await commandIdea(parsed); break;
      case 'compile': result = commandCompile(parsed); break;
      default: throw new Error('Неизвестная команда: ' + parsed.command);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write('Ошибка: ' + (error && error.message ? error.message : String(error)) + '\n');
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write('Ошибка: ' + (error && error.message ? error.message : String(error)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  parsePort,
  parseFrontmatter,
  loadProfile,
  compileTicket,
  renderValue,
  profilesDir,
  DEFAULT_PORT,
  HOST,
  REQUIRED_FIELDS,
};
