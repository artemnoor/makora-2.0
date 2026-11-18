'use strict';

// Локальный HTTP-сервер панели. Слушает только 127.0.0.1, без CORS.
// Human-решения принимаются только из браузера того же источника.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Store, ActionError, PHASES, HUMAN_DESIGN_STEPS, makeLogger } = require('./store.cjs');
const { LabRunner, defaultRunRoot } = require('./labs.cjs');
const { ZIP_LIMIT, OutsourceError } = require('./outsource.cjs');
const OUTSOURCE_ROUTE = /^\/api\/outsources\/([a-f0-9]{16})\/(outsource_[a-f0-9]{16})\/(brief|contract|archive)$/;

const DEFAULT_PORT = 18741;
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const WEB_DIR = path.join(__dirname, 'web');
const STATIC_ASSETS = new Set(['index.html', 'app.js', 'styles.css']);

// Статические файлы фиксированы: только три имени из dashboard/web, обход каталога невозможен.
// Встроенные копии используются, если каталог web не создан.
function assetBody(name, embedded) {
  if (!STATIC_ASSETS.has(name)) return embedded;
  try {
    const file = path.join(WEB_DIR, name);
    if (fs.statSync(file).isFile()) return fs.readFileSync(file, 'utf8');
  } catch { /* используем встроенную копию */ }
  return embedded;
}

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function resolveConfig(options = {}) {
  const rawPort = options.port ?? process.env.DASHBOARD_PORT ?? DEFAULT_PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('DASHBOARD_PORT должен быть целым числом от 0 до 65535.');
  }
  const dataDir = path.resolve(options.dataDir || process.env.DASHBOARD_DATA_DIR || path.join(__dirname, 'data'));
  return {
    port,
    dataDir,
    host: '127.0.0.1',
    runRoot: path.resolve(options.runRoot || defaultRunRoot()),
    observer: options.observer || null,
    readyTimeoutMs: options.readyTimeoutMs,
    logger: options.logger,
    now: options.now,
    spawn: options.spawn,
    net: options.net,
    executables: options.executables,
    verifyWorktree: options.verifyWorktree,
  };
}

function loadObserver(provided) {
  if (provided) return provided;
  try {
    // Файл необязателен: подключение к наблюдателю запусков не требуется по умолчанию.
    const candidate = require('./observer.cjs');
    const observe = candidate && typeof candidate.observe === 'function'
      ? candidate.observe
      : candidate && candidate.default && typeof candidate.default.observe === 'function'
        ? candidate.default.observe
        : null;
    return observe ? { observe } : null;
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND' && String(error.message).includes('observer.cjs')) return null;
    throw error;
  }
}

function effectivePort(config, server) {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : config.port;
}

function checkRequestOrigin(req, config, server) {
  const hostHeader = String(req.headers.host || '');
  const hostname = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  const portPart = hostHeader.startsWith('[') ? hostHeader.slice(hostHeader.indexOf(']') + 1).replace(/^:/, '') : hostHeader.split(':')[1];
  const port = effectivePort(config, server);
  if (!LOOPBACK_HOSTS.has(String(hostname).toLowerCase())) {
    throw new HttpError(403, `Запрос отвергнут: заголовок Host должен быть loopback (127.0.0.1:${port}).`, 'host.rejected');
  }
  if (portPart && portPart !== String(port)) {
    throw new HttpError(403, `Запрос отвергнут: порт в Host должен быть ${port}.`, 'host.rejected');
  }
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`,
    ]);
    if (!allowed.has(String(origin))) {
      throw new HttpError(403, `Запрос отвергнут: чужой Origin «${origin}». Разрешён только тот же источник.`, 'origin.rejected');
    }
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(String(site))) {
    throw new HttpError(403, 'Запрос отвергнут: браузер сообщил о межсайтовом источнике.', 'fetch_site.rejected');
  }
}

function requiresBrowser(payload) {
  // Решения человека и управление запуском демо приходят из интерфейса того же
  // источника. Настройка демо (lab.configure) остаётся доступной локальному CLI.
  if (payload.action === 'idea.decide' || payload.action === 'lab.decide') return true;
  if (payload.action === 'lab.start' || payload.action === 'lab.stop') return true;
  if (payload.action === 'design.advance' && HUMAN_DESIGN_STEPS.has(payload.step)) return true;
  return false;
}

function isHumanActor(req) {
  return Boolean(req.headers.origin);
}

function checkHumanDecision(req, payload) {
  if (payload.action === 'design.figma.sync' && isHumanActor(req)) {
    throw new ActionError(
      'Синхронизацию Figma выполняет локальный CLI (Codex), а не браузер.',
      'cli_required',
      { action: payload.action }
    );
  }
  if (!requiresBrowser(payload)) return;
  if (!isHumanActor(req)) {
    throw new ActionError(
      `Решение человека принимается только в браузере на том же источнике. Повторите действие в интерфейсе панели.`,
      'browser_required',
      { action: payload.action, step: payload.step || null }
    );
  }
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') {
    throw new ActionError('Браузер сообщил о не-same-origin запросе: решение не принято.', 'browser_required', { action: payload.action });
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new HttpError(413, `Тело запроса слишком большое (максимум ${maxBytes} байт).`, 'body.too_large'));
      return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
      } else if (!tooLarge) {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `Тело запроса слишком большое (максимум ${maxBytes} байт).`, 'body.too_large'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function send(res, status, body, contentType, extra = {}) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...extra,
  };
  // Намеренно нет Access-Control-Allow-Origin: панель не является CORS-сервисом.
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value) + '\n', 'application/json; charset=utf-8');
}

const INDEX_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Панель проектов</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="top">
  <h1>Панель проектов</h1>
  <p class="lead">Панель ведёт учёт фаз, задач, идей, лабораторий и проектирования. Она не изменяет исходный код и не запускает агентов OpenCode.</p>
</header>
<main>
  <section class="card">
    <h2>Зарегистрировать проект</h2>
    <form data-action="project.add" class="grid">
      <label>Название<input name="name" required maxlength="200" placeholder="Новый проект"></label>
      <label>Путь к каталогу<input name="path" required placeholder="C:\\Projects\\example"></label>
      <div class="row"><button type="submit">Добавить проект</button></div>
    </form>
  </section>
  <div id="projects" class="stack"></div>
</main>
<div id="notice" class="notice" role="status" aria-live="polite"></div>
<script src="/app.js"></script>
</body>
</html>
`;

const STYLES_CSS = `:root { color-scheme: light; --bg: #f5f6f8; --card: #ffffff; --ink: #18202b; --muted: #5c6875; --line: #d8dee6; --accent: #1b5e8a; --ok: #1d6b45; --warn: #8a5200; --bad: #9b2f2f; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
.top { padding: 28px clamp(16px, 4vw, 48px) 18px; border-bottom: 1px solid var(--line); background: var(--card); }
h1 { margin: 0 0 6px; font-size: clamp(24px, 3vw, 34px); letter-spacing: -0.02em; }
h2 { margin: 0 0 14px; font-size: 20px; }
h3 { margin: 18px 0 8px; font-size: 17px; }
.lead { margin: 0; color: var(--muted); max-width: 80ch; }
main { padding: 22px clamp(16px, 4vw, 48px) 60px; }
.stack { display: grid; gap: 18px; margin-top: 18px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px; box-shadow: 0 1px 2px rgba(20,30,45,.05); }
.card h2 { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.path { color: var(--muted); font-size: 13px; font-weight: 400; word-break: break-all; }
.grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); align-items: end; }
.grid label, label { display: grid; gap: 5px; color: var(--muted); font-size: 14px; }
input, textarea, select { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); font: inherit; }
textarea { min-height: 72px; resize: vertical; }
input:focus-visible, textarea:focus-visible, select:focus-visible, button:focus-visible { outline: 3px solid #8ab7d6; outline-offset: 2px; }
button { padding: 8px 14px; border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: #fff; font: inherit; cursor: pointer; }
button.secondary { background: #fff; color: var(--accent); }
button.danger { background: #fff; color: var(--bad); border-color: var(--bad); }
button[aria-current="step"] { background: var(--ok); border-color: var(--ok); }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.list { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
.item { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: #fbfcfd; }
.item strong { font-weight: 600; }
.meta { color: var(--muted); font-size: 13px; word-break: break-word; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; background: #e8eef4; color: var(--ink); font-size: 12px; }
.badge.ok { background: #e2f2e9; color: var(--ok); }
.badge.warn { background: #fdf0d9; color: var(--warn); }
.badge.bad { background: #f9e5e5; color: var(--bad); }
.phases { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.phases button { padding: 5px 10px; font-size: 13px; }
.banner { margin-top: 14px; padding: 10px 14px; border: 1px solid #d6a84a; border-radius: 8px; background: #fff6e3; color: var(--warn); }
.notice { position: fixed; right: 18px; bottom: 18px; max-width: min(460px, calc(100vw - 36px)); padding: 12px 14px; border-radius: 8px; background: #18202b; color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.2); display: none; z-index: 10; }
.notice.show { display: block; }
.notice.error { background: var(--bad); }
.subtle { color: var(--muted); font-size: 13px; }
@media (max-width: 600px) { .card { padding: 14px; } button { width: 100%; } }
`;

const APP_JS = `'use strict';
const notice = document.getElementById('notice');
const ARRAY_FIELDS = new Set(['criteria', 'modulePaths', 'demoPaths', 'dependsOn', 'args', 'frames']);
const PHASES = ${JSON.stringify(PHASES)};
const HUMAN_STEPS = new Set(['references_approved', 'figma_approved']);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function lines(value) {
  return String(value || '').split(/[\\r\\n,]+/).map((v) => v.trim()).filter(Boolean);
}
function showNotice(message, isError) {
  notice.textContent = message;
  notice.className = 'notice show' + (isError ? ' error' : '');
}
async function api(action, payload) {
  const response = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}
function badge(value, kind) { return '<span class="badge ' + (kind || '') + '">' + esc(value) + '</span>'; }
function acceptanceBadge(entry) {
  if (entry && (entry.accepted === true || entry.acceptance === 'accepted')) return badge('Принято', 'ok');
  return badge('Приёмка не выполнена', 'warn');
}

function renderIdeas(project) {
  const items = project.ideas.map((idea) => {
    const decide = idea.decision
      ? badge(decisionLabel(idea.decision), idea.decision === 'accepted' ? 'ok' : idea.decision === 'rejected' ? 'bad' : 'warn')
      : '<span class="row">' + ['accepted','rejected','deferred'].map((d) => '<button class="secondary" data-act="idea.decide" data-project="' + esc(project.id) + '" data-id="' + esc(idea.id) + '" data-decision="' + d + '">' + decisionLabel(d) + '</button>').join('') + '</span>';
    return '<li class="item"><strong>' + esc(idea.text) + '</strong>' + (idea.proposal ? '<div class="meta">Предложение: ' + esc(idea.proposal) + '</div>' : '') + '<div class="row">' + decide + '</div></li>';
  }).join('');
  return '<section><h3>Идеи</h3><form data-action="idea.add" class="grid">' +
    '<input type="hidden" name="projectId" value="' + esc(project.id) + '">' +
    '<label>Текст идеи<input name="text" required></label>' +
    '<label>Предложение<input name="proposal"></label>' +
    '<label>После задачи<input name="afterTaskId"></label>' +
    '<div class="row"><button type="submit">Добавить идею</button></div></form>' +
    (items ? '<ul class="list">' + items + '</ul>' : '<p class="subtle">Идей пока нет.</p>') + '</section>';
}
function decisionLabel(value) {
  return ({accepted:'Принято', rejected:'Отклонено', deferred:'Отложено', approved:'Одобрено', changes_requested:'Запросить изменения'})[value] || value;
}
function renderTasks(project) {
  const items = project.tasks.map((task) => '<li class="item"><strong>' + esc(task.title) + '</strong> ' + badge(esc(task.stage)) + ' ' + badge(esc(task.status)) + ' ' + acceptanceBadge(task) +
    '<div class="meta">ID: ' + esc(task.id) + (task.agent ? ' · агент: ' + esc(task.agent) : '') + (task.model ? ' · модель: ' + esc(task.model) : '') +
    (task.runId ? ' · запуск: ' + esc(task.runId) : '') + (task.sessionId ? ' · сессия: ' + esc(task.sessionId) : '') + '</div>' +
    (task.acceptanceEvidence ? '<div class="meta">Доказательство приёмки: ' + esc(task.acceptanceEvidence) + '</div>' : '') +
    (Array.isArray(task.criteria) && task.criteria.length ? '<div class="meta">Критерии: ' + esc(task.criteria.join('; ')) + '</div>' : '') +
    (task.dependsOn && task.dependsOn.length ? '<div class="meta">Зависимости: ' + esc(task.dependsOn.join(', ')) + '</div>' : '') + '</li>').join('');
  return '<section><h3>Задачи</h3><form data-action="task.put" class="grid">' +
    '<input type="hidden" name="projectId" value="' + esc(project.id) + '">' +
    '<label>ID<input name="id" required></label><label>Название<input name="title" required></label>' +
    '<label>Этап<input name="stage" required></label><label>Статус<input name="status" required></label>' +
    '<label>Агент<input name="agent"></label><label>Модель<input name="model"></label>' +
    '<label>Run ID<input name="runId"></label><label>Session ID<input name="sessionId"></label>' +
    '<label>Критерии (через ;)<textarea name="criteria"></textarea></label>' +
    '<label>Доказательства<textarea name="evidence"></textarea></label>' +
    '<label>Зависимости (через ;)<input name="dependsOn"></label>' +
    '<div class="row"><button type="submit">Сохранить задачу</button></div></form>' +
    (items ? '<ul class="list">' + items + '</ul>' : '<p class="subtle">Задач пока нет.</p>') + '</section>';
}
function renderLab(lab, project) {
  const stateBadge = badge(lab.state, lab.state === 'accepted' ? 'ok' : ['failed','rejected'].includes(lab.state) ? 'bad' : 'warn');
  let controls = '';
  if (lab.state === 'proposed') {
    controls = '<div class="row"><button data-act="lab.decide" data-project="' + esc(project.id) + '" data-id="' + esc(lab.id) + '" data-decision="approved">Одобрить</button>' +
      '<button class="danger" data-act="lab.decide" data-project="' + esc(project.id) + '" data-id="' + esc(lab.id) + '" data-decision="rejected">Отклонить</button></div>';
  } else if (lab.state === 'approved') {
    controls = '<form data-action="lab.configure" class="grid">' +
      '<input type="hidden" name="projectId" value="' + esc(project.id) + '"><input type="hidden" name="id" value="' + esc(lab.id) + '">' +
      '<label>cwd демонстрации<input name="cwd" required value="' + esc(project.path) + '"></label>' +
      '<label>Среда<select name="runtime"><option value="node">node</option><option value="python">python</option></select></label>' +
      '<label>Аргументы (поддерживаются {port} и {data})<textarea name="args" placeholder="-e &quot;http-сервер...listen({port})&quot;"></textarea></label>' +
      '<label>Доказательство<input name="evidence" required></label>' +
      '<div class="row"><button type="submit">Настроить демо</button></div></form>';
  } else if (['configured','ready'].includes(lab.state)) {
    controls = '<div class="row"><button data-act="lab.start" data-project="' + esc(project.id) + '" data-id="' + esc(lab.id) + '">Запустить демо</button>' +
      (['running','ready'].includes(lab.runtime) ? '<button class="secondary" data-act="lab.stop" data-project="' + esc(project.id) + '" data-id="' + esc(lab.id) + '">Остановить демо</button>' : '') +
      (lab.readySeen ? '<button data-act="lab.decide" data-project="' + esc(project.id) + '" data-id="' + esc(lab.id) + '" data-decision="accepted">Принять лабораторию</button>' +
        '<button class="secondary" data-act="lab.decide" data-project="' + esc(project.id) + '" data-id="' + esc(lab.id) + '" data-decision="changes_requested">Запросить изменения</button>' : '<span class="subtle">Приёмка станет доступна после готового демо.</span>') + '</div>';
  }
  const last = lab.lastRun;
  return '<li class="item"><strong>' + esc(lab.title) + '</strong> ' + stateBadge + ' ' + badge('исполнение: ' + lab.runtime) +
    '<div class="meta">Сценарий: ' + esc(lab.scenario) + '</div>' +
    '<div class="meta">Критерии: ' + esc((lab.criteria || []).join('; ')) + '</div>' +
    '<div class="meta">Модули: ' + esc((lab.modulePaths || []).join(', ')) + ' · Демо: ' + esc((lab.demoPaths || []).join(', ')) + '</div>' +
    (lab.proof ? '<div class="meta">Доказательство: ' + esc(lab.proof) + '</div>' : '') +
    (last ? '<div class="meta">Последний запуск: ' + esc(last.status) + (last.port ? ' · порт ' + esc(last.port) : '') + (last.error ? ' · ' + esc(last.error) : '') + '</div>' : '') +
    controls + '</li>';
}
function renderLabs(project) {
  const items = project.labs.map((lab) => renderLab(lab, project)).join('');
  return '<section><h3>Лаборатории</h3><form data-action="lab.propose" class="grid">' +
    '<input type="hidden" name="projectId" value="' + esc(project.id) + '">' +
    '<label>Название<input name="title" required></label><label>Сценарий<input name="scenario" required></label>' +
    '<label>Критерии (через ;)<textarea name="criteria" required></textarea></label>' +
    '<label>Пути модулей (через ;)<textarea name="modulePaths" required></textarea></label>' +
    '<label>Пути демонстрации (через ;)<textarea name="demoPaths" required></textarea></label>' +
    '<label>Доказательство<input name="proof"></label>' +
    '<div class="row"><button type="submit">Предложить лабораторию</button></div></form>' +
    (items ? '<ul class="list">' + items + '</ul>' : '<p class="subtle">Лабораторий пока нет.</p>') + '</section>';
}
function designSyncProof(design) {
  if (!design || !Array.isArray(design.history)) return null;
  for (let i = design.history.length - 1; i >= 0; i -= 1) {
    const entry = design.history[i];
    if (!entry || entry.step !== 'figma_ready') continue;
    if (entry.source !== 'figma-mcp' || entry.verified !== true) continue;
    if (!Array.isArray(entry.frames) || !entry.frames.length) continue;
    return entry;
  }
  return null;
}
function renderFigmaProof(proof) {
  if (!proof) return '';
  const fileUrl = typeof (proof.fileUrl || proof.artifact) === 'string' ? (proof.fileUrl || proof.artifact) : '';
  const fileKey = typeof proof.fileKey === 'string' ? proof.fileKey : '';
  let out = '<div class="meta"><strong>Сохранённая синхронизация Figma (Codex):</strong></div>';
  if (fileUrl) out += '<div class="meta">Файл: <a href="' + esc(fileUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(fileUrl) + '</a>' + (fileKey ? ' <span class="badge">fileKey: ' + esc(fileKey) + '</span>' : '') + '</div>';
  out += '<ul class="list">';
  for (const frame of proof.frames) {
    if (!frame || typeof frame !== 'object') continue;
    const name = frame.name || '';
    const nodeId = frame.nodeId || '';
    const url = typeof frame.url === 'string' ? frame.url : '';
    out += '<li class="item"><strong>' + esc(name) + '</strong> <span class="meta">nodeId: ' + esc(nodeId) + '</span>' +
      (url ? '<div class="meta"><a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + '</a></div>' : '') + '</li>';
  }
  out += '</ul>';
  return out;
}
function renderDesign(design, project) {
  const next = design.nextStep;
  const proof = designSyncProof(design);
  let advance = '<p class="subtle">Все шаги пройдены.</p>';
  if (next === 'figma_ready') {
    advance = '<p class="subtle">Ожидание синхронизации из Codex (design.figma.sync). Ручной ввод отключён.</p>';
  } else if (design.step === 'figma_ready' && proof) {
    advance = renderFigmaProof(proof) +
      '<form data-action="design.advance" class="grid">' +
      '<input type="hidden" name="projectId" value="' + esc(project.id) + '"><input type="hidden" name="id" value="' + esc(design.id) + '">' +
      '<input type="hidden" name="step" value="figma_approved">' +
      '<div><strong>Второе решение человека:</strong> подтвердить Figma <span class="badge warn">решение человека в браузере</span></div>' +
      '<label>Примечание<input name="note"></label>' +
      '<div class="row"><button type="submit">Подтвердить Figma (figma_approved)</button></div></form>';
  } else if (design.step === 'figma_ready' && !proof) {
    advance = '<p class="subtle">Ожидание синхронизации из Codex (design.figma.sync). Подтверждение Figma станет доступно после сохранённой синхронизации.</p>';
  } else if (next) {
    const savedProof = proof && ['figma_approved', 'implemented', 'reviewed'].includes(design.step) ? renderFigmaProof(proof) : '';
    advance = savedProof + '<form data-action="design.advance" class="grid">' +
      '<input type="hidden" name="projectId" value="' + esc(project.id) + '"><input type="hidden" name="id" value="' + esc(design.id) + '">' +
      '<input type="hidden" name="step" value="' + esc(next) + '">' +
      '<div><span class="subtle">Следующий шаг: </span><strong>' + esc(next) + '</strong>' + (HUMAN_STEPS.has(next) ? ' <span class="badge warn">решение человека в браузере</span>' : '') + '</div>' +
      (HUMAN_STEPS.has(next) ? '' : '<label>Артефакт / ссылка / доказательство<textarea name="artifact"></textarea></label>') +
      '<label>Примечание<input name="note"></label>' +
      '<div class="row"><button type="submit">' + (HUMAN_STEPS.has(next) ? 'Подтвердить (' + esc(next) + ')' : 'Продвинуть шаг') + '</button></div></form>';
  } else if (proof) {
    advance = renderFigmaProof(proof) + '<p class="subtle">Все шаги пройдены.</p>';
  }
  return '<li class="item"><strong>' + esc(design.title) + '</strong> ' + badge(design.step ? 'шаг: ' + design.step : 'создано') +
    '<div class="meta">' + esc((design.history || []).map((h) => h.step).join(' → ') || 'шаги ещё не начинались') + '</div>' + advance + '</li>';
}
function renderDesigns(project) {
  const items = project.designs.map((d) => renderDesign(d, project)).join('');
  return '<section><h3>Проектирование</h3><form data-action="design.create" class="grid">' +
    '<input type="hidden" name="projectId" value="' + esc(project.id) + '">' +
    '<label>Название<input name="title" required></label><div class="row"><button type="submit">Создать</button></div></form>' +
    (items ? '<ul class="list">' + items + '</ul>' : '<p class="subtle">Проектов проектирования пока нет.</p>') + '</section>';
}
function renderRuns(project) {
  const items = project.runs.map((run) => '<li class="item"><strong>' + esc(run.runId || run.id) + '</strong> ' + badge(esc(run.source)) + ' ' + acceptanceBadge(run) +
    '<div class="meta">' + esc(run.status) + (run.sessionId ? ' · сессия ' + esc(run.sessionId) : '') + ' · ' + esc(run.updatedAt || run.finishedAt || '') + '</div>' +
    (run.mode ? '<div class="meta">Режим: ' + esc(run.mode) + (run.baseSha ? ' · ' + esc(run.baseSha) : '') + '</div>' : '') +
    (Array.isArray(run.workers) && run.workers.length ? '<div class="meta">Участники: ' + esc(run.workers.map((worker) => worker.name).join(', ')) + '</div>' : '') +
    (run.note ? '<div class="meta">' + esc(run.note) + '</div>' : '') + '</li>').join('');
  return '<section><h3>Запуски</h3>' + (items ? '<ul class="list">' + items + '</ul>' : '<p class="subtle">Запуски сообщаются наблюдателем или через задачи.</p>') + '</section>';
}
function renderDecisions(project) {
  const items = project.decisions.map((d) => '<li class="item"><strong>' + esc(decisionLabel(d.decision)) + '</strong> <span class="meta">' + esc(d.type) + ' · ' + esc(d.targetId) + ' · ' + esc(d.ts) + ' · ' + esc(d.source) + '</span></li>').join('');
  return '<section><h3>Решения</h3>' + (items ? '<ul class="list">' + items + '</ul>' : '<p class="subtle">Решений пока нет.</p>') + '</section>';
}
function render(project) {
  const phases = '<div class="phases">' + PHASES.map((p) => '<button class="secondary" data-act="project.phase" data-project="' + esc(project.id) + '" data-phase="' + p + '"' + (project.phase === p ? ' aria-current="step"' : '') + '>' + esc(p) + '</button>').join('') + '</div>';
  return '<article class="card"><h2>' + esc(project.name) + ' <span class="path">' + esc(project.path) + '</span></h2>' +
    '<div class="meta">Фаза: <strong>' + esc(project.phase) + '</strong></div>' + phases +
    renderTasks(project) + renderIdeas(project) + renderLabs(project) + renderDesigns(project) + renderRuns(project) + renderDecisions(project) + '</article>';
}
async function refresh() {
  const state = await (await fetch('/api/state')).json();
  document.getElementById('projects').innerHTML = state.projects.length
    ? state.projects.map(render).join('')
    : '<p class="subtle">Проектов пока нет. Зарегистрируйте каталог проекта выше.</p>';
  for (const warning of state.warnings || []) showNotice(warning, true);
}
function formData(form) {
  const payload = {};
  for (const [key, value] of new FormData(form)) {
    const trimmed = String(value).trim();
    if (!trimmed) continue;
    payload[key] = ARRAY_FIELDS.has(key) ? lines(trimmed) : trimmed;
  }
  return payload;
}
function actionPayload(target) {
  const payload = { projectId: target.dataset.project };
  if (target.dataset.id) payload.id = target.dataset.id;
  if (target.dataset.decision) payload.decision = target.dataset.decision;
  if (target.dataset.phase) payload.phase = target.dataset.phase;
  return payload;
}
document.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-action]');
  if (!form) return;
  event.preventDefault();
  try {
    const result = await api(form.dataset.action, formData(form));
    showNotice(result.idempotent ? 'Действие уже было выполнено ранее.' : 'Изменение сохранено.', false);
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-act]');
  if (!button) return;
  try {
    await api(button.dataset.act, actionPayload(button));
    showNotice('Действие выполнено.', false);
    await refresh();
  } catch (error) { showNotice(error.message, true); }
});
refresh().catch((error) => showNotice(error.message, true));
setInterval(() => refresh().catch(() => {}), 5000);
`;

function createDashboard(options = {}) {
  const config = resolveConfig(options);
  const log = makeLogger({ logger: options.logger, debug: options.debug });
  const store = new Store({
    dataDir: config.dataDir,
    logger: log,
    now: config.now,
  });
  const labs = new LabRunner({
    dataDir: config.dataDir,
    runRoot: config.runRoot,
    logger: log,
    readyTimeoutMs: config.readyTimeoutMs,
    net: config.net,
    spawn: config.spawn,
    executables: config.executables,
    verifyWorktree: config.verifyWorktree,
  });
  const observer = loadObserver(config.observer);

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    try {
      checkRequestOrigin(req, config, server);
      pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const outsourceRoute = OUTSOURCE_ROUTE.exec(pathname);
      if (outsourceRoute) {
        const [, projectId, id, resource] = outsourceRoute;
        if (req.method === 'GET' && resource !== 'archive') {
          const brief = store.outsourceBrief(projectId, id);
          const body = JSON.stringify(resource === 'contract' ? brief.openapi : brief, null, 2) + '\n';
          send(res, 200, body, 'application/json; charset=utf-8', {
            'Content-Disposition': 'attachment; filename="' + id + '-' + resource + '.json"',
          });
          return;
        }
        if (req.method === 'POST' && resource === 'archive') {
          if (!/^application\/zip(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
            throw new HttpError(415, 'Ожидается ZIP с Content-Type: application/zip.', 'content_type');
          }
          store.getOutsource(projectId, id);
          const buffer = await readBody(req, ZIP_LIMIT);
          const result = await store.outsourceImport(projectId, id, buffer, isHumanActor(req) ? 'browser' : 'cli');
          sendJson(res, 200, result);
          return;
        }
        throw new HttpError(405, 'Метод не поддерживается.', 'method_not_allowed');
      }
      if (req.method === 'GET') {
        if (pathname === '/' || pathname === '/index.html') {
          send(res, 200, assetBody('index.html', INDEX_HTML), 'text/html; charset=utf-8');
          return;
        }
        if (pathname === '/app.js') {
          send(res, 200, assetBody('app.js', APP_JS), 'text/javascript; charset=utf-8');
          return;
        }
        if (pathname === '/styles.css') {
          send(res, 200, assetBody('styles.css', STYLES_CSS), 'text/css; charset=utf-8');
          return;
        }
        if (pathname === '/api/state') {
          const state = store.getState({ observer, runRoot: config.runRoot });
          sendJson(res, 200, state);
          return;
        }
        if (pathname === '/api/audit') {
          const requested = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('projectId');
          if (requested) store.getProject(requested);
          sendJson(res, 200, { entries: store.auditEntries(requested) });
          return;
        }
        if (pathname === '/api/health') {
          sendJson(res, 200, { ok: true, port: effectivePort(config, server) });
          return;
        }
        throw new HttpError(404, 'Страница не найдена.', 'not_found');
      }
      if (req.method === 'POST' && pathname === '/api/actions') {
        const contentType = String(req.headers['content-type'] || '');
        if (!/^application\/json\b/i.test(contentType)) {
          throw new HttpError(415, 'Ожидается JSON с Content-Type: application/json.', 'content_type');
        }
        const raw = await readBody(req, MAX_BODY_BYTES);
        let payload;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          throw new HttpError(400, 'Тело запроса не является корректным JSON.', 'json.invalid');
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new HttpError(400, 'Тело запроса должно быть JSON-объектом.', 'json.object_required');
        }
        if (Object.keys(payload).length > 40) {
          throw new HttpError(400, 'Слишком много полей в действии.', 'json.too_many_fields');
        }
        checkHumanDecision(req, payload);
        const actor = isHumanActor(req) ? 'browser' : 'cli';
        const ctx = { actor, runRoot: config.runRoot };
        let result;
        switch (payload.action) {
          case 'lab.start': {
            const pre = store.labStartPrepare(payload, actor);
            try {
              const outcome = await labs.start({ labId: pre.labId, config: pre.config });
              store.labStartFinish(pre.labId, outcome);
              result = { ok: true, labId: pre.labId, ready: true, port: outcome.port, data: outcome.data, note: outcome.note };
            } catch (error) {
              const details = error.details || {};
              store.labStartFinish(pre.labId, {
                ok: false,
                ready: false,
                port: details.port || null,
                data: null,
                startedAt: new Date().toISOString(),
                endedAt: new Date().toISOString(),
                error: error.message,
                log: details.log || null,
              });
              throw error;
            }
            break;
          }
          case 'lab.stop': {
            const pre = store.labStopPrepare(payload, actor);
            const outcome = await labs.stop(pre.labId);
            store.labStopFinish(pre.labId, outcome);
            result = { ok: true, labId: pre.labId, stopped: outcome.stopped, note: outcome.note };
            break;
          }
          case 'lab.configure': {
            const project = store.getProject(payload.projectId);
            const cwd = labs.validateCwd(project.path, payload.cwd, project.id);
            result = store.perform({ ...payload, cwd }, ctx);
            break;
          }
          default:
            result = store.perform(payload, ctx);
        }
        sendJson(res, 200, result);
        return;
      }
      if (req.method === 'POST') throw new HttpError(404, 'Маршрут не найден.', 'not_found');
      throw new HttpError(405, 'Метод не поддерживается.', 'method_not_allowed');
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof HttpError || error instanceof OutsourceError) {
        sendJson(res, error.status, { error: error.message, code: error.code });
        return;
      }
      if (error instanceof ActionError) {
        sendJson(res, 200, error.toJSON());
        return;
      }
      log('error', 'request failed', { pathname, error: error.message });
      sendJson(res, 500, { error: `Внутренняя ошибка панели: ${error.message}`, code: 'internal' });
    }
  });

  return {
    server,
    store,
    labs,
    config,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => {
          server.off('error', onError);
          log('info', 'dashboard listening', { host, port: effectivePort(config, server) });
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    get port() { return effectivePort(config, server); },
    getState() { return store.getState({ observer, runRoot: config.runRoot }); },
    async close() {
      await labs.close();
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      store.close();
      log('debug', 'dashboard closed');
    },
  };
}

module.exports = {
  createDashboard,
  createServer: createDashboard,
  HttpError,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
};

if (require.main === module) {
  const dashboard = createDashboard();
  const shutdown = async () => {
    try { await dashboard.close(); } finally { process.exit(0); }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  dashboard.listen().catch((error) => {
    process.stderr.write(`Не удалось запустить панель: ${error.message}\n`);
    process.exitCode = 1;
  });
}
