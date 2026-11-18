'use strict';

// Контрольная комната: только чтение /api/state и явные действия через /api/actions.
// Никаких внешних зависимостей, хранилищ, расширений браузера или управления процессами.
(function () {
  var PHASES = [
    { id: 'brief', label: 'Бриф' },
    { id: 'architecture', label: 'Архитектура' },
    { id: 'scaffold', label: 'Каркас' },
    { id: 'implementation', label: 'Реализация' },
    { id: 'assembly', label: 'Сборка' },
    { id: 'acceptance', label: 'Приёмка' },
    { id: 'complete', label: 'Завершено' }
  ];

  var DESIGN_STEPS = [
    { id: 'references_ready', label: 'Источники готовы' },
    { id: 'references_approved', label: 'Источники приняты' },
    { id: 'figma_ready', label: 'Figma готова' },
    { id: 'figma_approved', label: 'Figma принята' },
    { id: 'implemented', label: 'Реализовано' },
    { id: 'reviewed', label: 'Проверено' }
  ];

  var HUMAN_DESIGN_STEPS = ['references_approved', 'figma_approved'];

  var STATUS_LABELS = {
    queued: 'в очереди',
    pending: 'ожидает',
    planned: 'запланировано',
    in_progress: 'в работе',
    active: 'активно',
    running: 'запущено',
    started: 'запущено',
    blocked: 'заблокировано',
    proposed: 'предложено',
    approved: 'одобрено',
    configured: 'настроено',
    ready: 'готово',
    accepted: 'принято',
    rejected: 'отклонено',
    deferred: 'отложено',
    changes_requested: 'запрошены изменения'
  };

  var DECISION_LABELS = {
    accepted: 'принято',
    approved: 'одобрено',
    rejected: 'отклонено',
    deferred: 'отложено',
    changes_requested: 'запрошены изменения'
  };

  var LINK_LABELS = {
    report: 'Отчёт',
    reportUrl: 'Отчёт',
    reportLink: 'Отчёт',
    verification: 'Проверка',
    verificationUrl: 'Проверка',
    verifyUrl: 'Проверка',
    preview: 'Предпросмотр',
    previewUrl: 'Локальный предпросмотр',
    figma: 'Figma',
    figmaUrl: 'Figma',
    link: 'Ссылка',
    url: 'Ссылка',
    evidenceUrl: 'Доказательство',
    logUrl: 'Журнал'
  };

  var refs = {};
  var view = {
    raw: null,
    projects: [],
    selectedId: '',
    lastSync: null,
    connected: false
  };
  var renderSig = Object.create(null);
  var toastTimer = null;
  var loadPromise = null;
  var activeTab = 'git';

  function byId(id) { return document.getElementById(id); }

  function cacheRefs() {
    [
      'apiStatus', 'apiStatusText', 'figmaStatus', 'figmaStatusText', 'syncTime',
      'projectSelect', 'projectForm', 'projectMeta', 'refreshBtn', 'taskForm',
      'phasePath', 'frontendTrackBody', 'labTrackBody', 'blockers', 'taskList',
      'taskCount', 'decisionFeed', 'gitContent', 'ideaForm', 'ideaList',
      'labForm', 'labList', 'designForm', 'designList', 'detailDialog',
      'detailKind', 'detailTitle', 'detailBody', 'toast'
    ].forEach(function (id) { refs[id] = byId(id); });
  }

  function lower(value) {
    return String(value === undefined || value === null ? '' : value).trim().toLowerCase();
  }

  function valueOrEmpty(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function text(value, fallback) {
    var miss = fallback === undefined ? 'неизвестно' : fallback;
    if (value === undefined || value === null || value === '') return miss;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      var parts = value.map(function (item) { return text(item, ''); }).filter(Boolean);
      return parts.length ? parts.join(', ') : miss;
    }
    if (typeof value === 'object') {
      var candidate = firstDefined(value, ['name', 'title', 'id', 'value', 'text', 'sha', 'branch']);
      return candidate === undefined ? miss : text(candidate, miss);
    }
    return String(value);
  }

  function firstDefined(source, keys) {
    if (!source || typeof source !== 'object') return undefined;
    for (var i = 0; i < keys.length; i += 1) {
      var value = source[keys[i]];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  function arrayOf(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') {
      return Object.keys(value).map(function (key) {
        var entry = value[key];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          return Object.assign({ id: key }, entry);
        }
        return { id: key, value: entry };
      });
    }
    return [];
  }

  function idOf(item) {
    if (!item || typeof item !== 'object') return valueOrEmpty(item).trim();
    return valueOrEmpty(firstDefined(item, ['id', '_id', 'uuid', 'key'])).trim();
  }

  function stringList(value) {
    if (value === undefined || value === null || value === '') return [];
    if (Array.isArray(value)) {
      return value.map(function (item) { return text(item, ''); }).filter(Boolean);
    }
    if (typeof value === 'object') return [text(value)];
    return String(value).split(/[\n,;]+/).map(function (part) { return part.trim(); }).filter(Boolean);
  }

  function parseList(input) {
    return String(input || '').split(/[\n,;]+/).map(function (part) { return part.trim(); }).filter(Boolean);
  }

  function parseArgs(input) {
    var raw = String(input || '').trim();
    if (!raw) return [];
    if (raw.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map(function (item) { return String(item); });
      } catch (ignored) { /* fallback to shell-like tokens */ }
    }
    var tokens = raw.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    return tokens.map(function (token) {
      if ((token.charAt(0) === '"' && token.charAt(token.length - 1) === '"') ||
          (token.charAt(0) === "'" && token.charAt(token.length - 1) === "'")) {
        return token.slice(1, -1);
      }
      return token;
    });
  }

  function formatArgs(value) {
    if (Array.isArray(value)) {
      return value.map(function (item) {
        var string = String(item);
        return /\s/.test(string) ? JSON.stringify(string) : string;
      }).join(' ');
    }
    return text(value, '');
  }

  function el(tag, options, children) {
    var node = document.createElement(tag);
    var opts = options || {};
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined && opts.text !== null) node.textContent = String(opts.text);
    if (opts.attrs) {
      Object.keys(opts.attrs).forEach(function (key) {
        var value = opts.attrs[key];
        if (value !== undefined && value !== null && value !== false) {
          node.setAttribute(key, String(value));
        }
      });
    }
    if (opts.data) {
      Object.keys(opts.data).forEach(function (key) { node.dataset[key] = String(opts.data[key]); });
    }
    if (opts.disabled) node.disabled = true;
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    if (children === undefined || children === null) return;
    var list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === undefined || child === null || child === false) return;
      if (Array.isArray(child)) { appendChildren(node, child); return; }
      if (child instanceof Node) { node.appendChild(child); return; }
      node.appendChild(document.createTextNode(String(child)));
    });
  }

  function fragment(children) {
    var holder = document.createDocumentFragment();
    appendChildren(holder, children);
    return holder;
  }

  function badge(label, tone) {
    return el('span', { class: 'badge', text: label, data: { state: tone || 'unknown' } });
  }

  function kv(label, value, mono) {
    return el('div', { class: 'kv' }, [
      el('span', { class: 'label', text: label }),
      el('span', { class: mono ? 'value mono' : 'value', text: text(value) })
    ]);
  }

  function kvGrid(cells) {
    return el('div', { class: 'kv-grid' }, cells.filter(Boolean));
  }

  function metaCell(label, value, mono, copyable) {
    var cell = el('div', { class: 'meta-cell' }, [
      el('span', { class: 'label', text: label }),
      el('span', { class: mono ? 'value mono' : 'value', text: text(value) })
    ]);
    if (copyable && value) {
      cell.appendChild(el('button', {
        class: 'btn btn-ghost btn-small copy-btn',
        text: 'Копировать путь',
        attrs: { type: 'button', 'data-command': 'copy', 'data-copy': text(value) }
      }));
    }
    return cell;
  }

  function emptyState(title, message) {
    return el('div', { class: 'empty' }, [
      el('strong', { text: title }),
      el('span', { text: message })
    ]);
  }

  function linesBlock(label, values) {
    var list = stringList(values);
    if (!list.length) return null;
    return el('div', {}, [
      el('p', { class: 'card-text', text: label }),
      el('ul', { class: 'list-lines' }, list.map(function (item) { return el('li', { text: item }); }))
    ]);
  }

  function safeUrl(raw) {
    if (typeof raw !== 'string') return null;
    var value = raw.trim();
    if (!value || /^(javascript|data|file|vbscript):/i.test(value) || value.indexOf('//') === 0) return null;
    var parsed;
    try { parsed = new URL(value); } catch (ignored) { return null; }
    if (parsed.username || parsed.password) return null;
    var protocol = lower(parsed.protocol);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    var host = lower(parsed.hostname).replace(/^\[|\]$/g, '');
    if (host === 'figma.com' || host.slice(-10) === '.figma.com') return { url: parsed.href, kind: 'figma' };
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return { url: parsed.href, kind: 'preview' };
    return null;
  }

  // Те же правила, что в Store.looksLikeLink() и validateDesignArtifact().
  function looksLikeLink(value) {
    var raw = typeof value === 'string' ? value : '';
    return /https?:\/\//i.test(raw) || /(?:\.{1,2}\/|\/)[^\s]+/.test(raw);
  }

  function isFigmaArtifact(value) {
    return typeof value === 'string' && /https?:\/\/(?:www\.)?figma\.com\//i.test(value.trim());
  }

  function designStepLabel(stepId) {
    var key = lower(stepId);
    for (var i = 0; i < DESIGN_STEPS.length; i += 1) {
      if (DESIGN_STEPS[i].id === key) return DESIGN_STEPS[i].label;
    }
    return key ? key : 'шаг не указан';
  }

  function linkRow(label, value) {
    var row = el('div', { class: 'link-row' }, [el('span', { class: 'value-label', text: label })]);
    var candidate = value;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      candidate = firstDefined(candidate, ['url', 'href', 'link', 'value']);
    }
    if (candidate === undefined || candidate === null || candidate === '') {
      row.appendChild(el('span', { class: 'link-value muted', text: 'неизвестно' }));
      return row;
    }
    var safe = safeUrl(candidate);
    if (safe) {
      row.appendChild(el('a', {
        class: 'link-value',
        text: text(candidate),
        attrs: { href: safe.url, target: '_blank', rel: 'noopener noreferrer' }
      }));
      row.appendChild(badge(safe.kind === 'figma' ? 'Figma' : 'локальный предпросмотр', safe.kind === 'figma' ? 'active' : 'complete'));
    } else {
      row.appendChild(el('span', { class: 'link-value', text: text(candidate) }));
      row.appendChild(badge('ссылка не разрешена', 'unknown'));
    }
    return row;
  }

  function decisionKey(value) {
    var raw = value;
    if (raw && typeof raw === 'object') {
      raw = firstDefined(raw, ['decision', 'status', 'outcome', 'result', 'value', 'type']);
    }
    var key = lower(raw);
    if (key === 'accepted' || key === 'accept' || key === 'принято') return 'accepted';
    if (key === 'rejected' || key === 'reject' || key === 'отклонено') return 'rejected';
    if (key === 'deferred' || key === 'defer' || key === 'отложено') return 'deferred';
    if (key === 'approved' || key === 'approve' || key === 'одобрено') return 'approved';
    if (key === 'changes_requested' || key === 'changes-requested' || key === 'needs_changes' ||
        key === 'changes' || key === 'запрошены изменения') return 'changes_requested';
    return '';
  }

  function decisionOf(project, item) {
    if (!project || !item) return '';
    var direct = decisionKey(firstDefined(item, ['decision', 'outcome', 'resolution', 'result']));
    if (direct) return direct;
    var itemId = idOf(item);
    if (!itemId) return '';
    for (var i = 0; i < project.decisions.length; i += 1) {
      var entry = project.decisions[i];
      var target = firstDefined(entry, ['ideaId', 'labId', 'taskId', 'designId', 'targetId', 'itemId']);
      if (idOf(target) !== itemId) continue;
      var key = decisionKey(firstDefined(entry, ['decision', 'status', 'outcome', 'result', 'value', 'type']));
      if (key) return key;
    }
    return '';
  }

  function statusLabel(value, explicitAccepted) {
    var key = lower(value);
    if (!key) return 'статус неизвестен';
    if (key === 'accepted') return 'принято';
    if (['done', 'completed', 'complete', 'finished', 'closed'].indexOf(key) !== -1) {
      return explicitAccepted ? 'завершено и принято' : 'завершено · приёмка не подтверждена';
    }
    if (STATUS_LABELS[key]) return STATUS_LABELS[key];
    return String(value);
  }

  function statusTone(value, explicitAccepted) {
    var key = lower(value);
    if (explicitAccepted || key === 'accepted') return 'accepted';
    if (key === 'blocked' || key === 'rejected' || key === 'error' || key === 'failed') return 'blocked';
    if (key === 'queued' || key === 'pending' || key === 'deferred' || key === 'changes_requested') return 'waiting';
    if (key === 'in_progress' || key === 'running' || key === 'active' || key === 'started') return 'active';
    if (['done', 'completed', 'complete', 'finished', 'closed'].indexOf(key) !== -1) return 'complete';
    if (!key) return 'unknown';
    return 'neutral';
  }

  function designSyncProof(design) {
    if (!design || !Array.isArray(design.history)) return null;
    for (var i = design.history.length - 1; i >= 0; i -= 1) {
      var entry = design.history[i];
      if (!entry || lower(firstDefined(entry, ['step'])) !== 'figma_ready') continue;
      if (firstDefined(entry, ['source']) !== 'figma-mcp' || firstDefined(entry, ['verified']) !== true) continue;
      var frames = arrayOf(firstDefined(entry, ['frames']));
      if (!frames.length) continue;
      return entry;
    }
    return null;
  }

  function labConfig(lab) {
    if (!lab || typeof lab !== 'object') return {};
    return firstDefined(lab, ['config', 'demoConfig', 'configuration', 'demo']) || {};
  }

  function isLabConfigured(lab) {
    var config = labConfig(lab);
    var cwd = firstDefined(config, ['cwd', 'path', 'root']);
    var runtime = lower(firstDefined(config, ['runtime']));
    var args = firstDefined(config, ['args']);
    var evidence = firstDefined(config, ['evidence']);
    return Boolean(cwd && (runtime === 'node' || runtime === 'python') && Array.isArray(args) && args.length && evidence);
  }

  // Живой процесс и подтверждённая готовность — разные факты: runtime=ready
  // означает работающий процесс, а приёмка требует readySeen + lastRun.status='ready'.
  function labRuntime(lab) {
    return lower(firstDefined(lab || {}, ['runtime']));
  }

  function labProcessRunning(lab) {
    return ['running', 'ready'].indexOf(labRuntime(lab)) !== -1;
  }

  function labStartAllowed(lab) {
    if (!lab || typeof lab !== 'object' || labProcessRunning(lab)) return false;
    return ['configured', 'ready'].indexOf(lower(firstDefined(lab, ['state']))) !== -1 && isLabConfigured(lab);
  }

  function labVerifiedReady(lab) {
    if (!lab || typeof lab !== 'object' || !lab.readySeen) return false;
    var lastRun = lab.lastRun && typeof lab.lastRun === 'object' ? lab.lastRun : null;
    return Boolean(lastRun && lower(firstDefined(lastRun, ['status'])) === 'ready');
  }

  // labDecide(): итоговые решения требуют и доказательной готовности, и состояния configured/ready.
  function labDecisionReady(lab) {
    return labVerifiedReady(lab) && ['configured', 'ready'].indexOf(lower(firstDefined(lab || {}, ['state']))) !== -1;
  }

  function labDemoPort(lab) {
    var lastRun = lab && lab.lastRun && typeof lab.lastRun === 'object' ? lab.lastRun : null;
    var port = lastRun ? firstDefined(lastRun, ['port']) : undefined;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return port;
  }

  function labDemoOpenAllowed(lab) {
    return labProcessRunning(lab) && labRuntime(lab) === 'ready' && labDemoPort(lab) !== null;
  }

  function labPhase(project, lab) {
    var decision = decisionOf(project, lab);
    // ФазаLab — это lab.state; исполнение (runtime) показывается отдельно.
    var state = lower(firstDefined(lab, ['state', 'status', 'phase', 'stage']));
    if (decision === 'rejected' || state === 'rejected') return 'rejected';
    if (decision === 'accepted') return 'accepted';
    if (decision === 'changes_requested') return 'changes_requested';
    if (['proposed', 'approved', 'configured', 'ready'].indexOf(state) !== -1) return state;
    if (decision === 'approved') return 'approved';
    if (!state) return 'proposed';
    return 'unknown';
  }

  function designStepIndex(design) {
    if (!design || typeof design !== 'object') return null;
    // projectState() возвращает stepIndex: -1 для только что созданного дизайна.
    var numeric = firstDefined(design, ['stepIndex', 'step_index']);
    if (typeof numeric === 'number' && isFinite(numeric)) {
      if (numeric === -1) return -1;
      return numeric >= 0 && numeric < DESIGN_STEPS.length ? numeric : null;
    }
    if (typeof numeric === 'string' && /^-?\d+$/.test(numeric.trim())) {
      var parsed = Number(numeric.trim());
      return designStepIndex({ stepIndex: parsed });
    }
    var value = firstDefined(design, ['step', 'currentStep', 'stage', 'phase']);
    if (value === undefined || value === null) {
      var history = arrayOf(design.history || design.steps || design.timeline || design.advance);
      for (var i = history.length - 1; i >= 0; i -= 1) {
        var past = lower(firstDefined(history[i], ['step', 'to', 'id', 'stage']));
        var pastIndex = indexOfStep(past);
        if (pastIndex !== -1) return pastIndex;
      }
      return -1;
    }
    var key = lower(value);
    if (key === '' || key === 'created' || key === 'new' || key === 'draft') return -1;
    var index = indexOfStep(key);
    return index === -1 ? null : index;
  }

  function expectedDesignStep(design) {
    var index = designStepIndex(design);
    if (index === null || index >= DESIGN_STEPS.length - 1) return null;
    return DESIGN_STEPS[index + 1].id;
  }

  function indexOfStep(key) {
    for (var i = 0; i < DESIGN_STEPS.length; i += 1) {
      if (DESIGN_STEPS[i].id === key) return i;
    }
    return -1;
  }

  function normalizeProject(raw) {
    var source = raw && typeof raw === 'object' ? raw : {};
    return {
      raw: source,
      id: idOf(firstDefined(source, ['id', '_id', 'uuid'])),
      name: text(firstDefined(source, ['name', 'title']), 'Без названия'),
      path: valueOrEmpty(firstDefined(source, ['path', 'cwd', 'root'])),
      phase: valueOrEmpty(firstDefined(source, ['phase', 'currentPhase', 'stage'])),
      tasks: arrayOf(source.tasks),
      ideas: arrayOf(source.ideas),
      labs: arrayOf(source.labs),
      designs: arrayOf(source.designs),
      runs: arrayOf(source.runs),
      decisions: arrayOf(source.decisions)
    };
  }

  function selectedProject() {
    for (var i = 0; i < view.projects.length; i += 1) {
      if (view.projects[i].id === view.selectedId) return view.projects[i];
    }
    return null;
  }

  function applyState(raw) {
    view.raw = raw && typeof raw === 'object' ? raw : {};
    view.projects = arrayOf(view.raw.projects).map(normalizeProject);
    if (!view.projects.some(function (project) { return project.id === view.selectedId; })) {
      view.selectedId = view.projects.length ? view.projects[0].id : '';
    }
    view.lastSync = new Date();
    view.connected = true;
  }

  function resetSignatures() { Object.keys(renderSig).forEach(function (key) { delete renderSig[key]; }); }

  function captureFormState(root) {
    var entries = [];
    var controls = root.querySelectorAll('input, textarea, select');
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      var key = control.getAttribute('data-draft-key') || control.name || control.id || 'index:' + i;
      var entry = { key: key, tag: control.tagName, value: control.value, checked: control.checked };
      if (control.tagName !== 'SELECT' && typeof control.selectionStart === 'number') {
        entry.start = control.selectionStart;
        entry.end = control.selectionEnd;
      }
      entries.push(entry);
    }
    var active = document.activeElement;
    var activeKey = active && root.contains(active)
      ? (active.getAttribute('data-draft-key') || active.name || active.id || '')
      : null;
    return { entries: entries, activeKey: activeKey, scrollTop: root.scrollTop || 0 };
  }

  function findControl(root, key) {
    var controls = root.querySelectorAll('input, textarea, select');
    for (var i = 0; i < controls.length; i += 1) {
      var control = controls[i];
      if ((control.getAttribute('data-draft-key') || control.name || control.id) === key) return control;
    }
    return null;
  }

  function restoreFormState(root, saved) {
    if (!saved) return;
    saved.entries.forEach(function (entry) {
      var control = findControl(root, entry.key);
      if (!control) return;
      if (control.tagName === 'SELECT') {
        var options = Array.prototype.slice.call(control.options || []);
        if (options.some(function (option) { return option.value === entry.value; })) control.value = entry.value;
      } else if (control.type === 'checkbox' || control.type === 'radio') {
        control.checked = entry.checked;
      } else {
        control.value = entry.value;
      }
      if (entry.start !== undefined && document.activeElement === control && typeof control.setSelectionRange === 'function') {
        try { control.setSelectionRange(entry.start, entry.end); } catch (ignored) { /* unsupported control */ }
      }
    });
    if (saved.activeKey) {
      var active = findControl(root, saved.activeKey);
      if (active && document.activeElement !== active) {
        try { active.focus({ preventScroll: true }); } catch (ignored) { active.focus(); }
      }
    }
    root.scrollTop = saved.scrollTop;
  }

  function renderRegion(key, node, signature, builder) {
    var stamp = JSON.stringify(signature);
    if (renderSig[key] === stamp) return false;
    var saved = captureFormState(node);
    node.replaceChildren(fragment(builder()));
    restoreFormState(node, saved);
    renderSig[key] = stamp;
    return true;
  }

  function renderStatus() {
    var apiState = view.connected ? 'connected' : (view.raw ? 'error' : 'loading');
    refs.apiStatus.dataset.state = apiState;
    refs.apiStatusText.textContent = apiState === 'connected'
      ? 'Связь активна'
      : (view.raw ? 'Нет связи · показан последний ответ' : 'Подключение…');
    refs.syncTime.textContent = view.lastSync
      ? 'Обновление: ' + view.lastSync.toLocaleTimeString('ru-RU')
      : 'Обновление: —';
    var project = selectedProject();
    var hasSynced = false;
    if (project) {
      for (var i = 0; i < project.designs.length; i += 1) {
        if (designSyncProof(project.designs[i])) { hasSynced = true; break; }
      }
    }
    refs.figmaStatus.dataset.state = hasSynced ? 'connected' : 'unknown';
    refs.figmaStatusText.textContent = hasSynced
      ? 'Figma: есть сохранённая синхронизация'
      : 'Figma: статус по артефактам дизайна';
  }

  function renderProjectOptions() {
    var options = view.projects.map(function (project) { return { id: project.id, name: project.name }; });
    var stamp = JSON.stringify(options);
    if (renderSig.select === stamp && refs.projectSelect.value === view.selectedId) return;
    var select = refs.projectSelect;
    var wasFocused = document.activeElement === select;
    var previous = select.value;
    var nodes = options.length
      ? options.map(function (option) { return el('option', { text: option.name, attrs: { value: option.id } }); })
      : [el('option', { text: 'Проекты не загружены', attrs: { value: '' } })];
    select.replaceChildren(fragment(nodes));
    if (previous && Array.prototype.some.call(select.options, function (option) { return option.value === previous; })) {
      select.value = previous;
    } else {
      select.value = view.selectedId || '';
    }
    if (wasFocused) select.focus({ preventScroll: true });
    renderSig.select = stamp;
  }

  function renderProjectMeta() {
    var project = selectedProject();
    if (!project) {
      refs.projectMeta.replaceChildren(emptyState('Проект не выбран', 'Зарегистрируйте проект или дождитесь ответа /api/state.'));
      return;
    }
    var phaseIndex = PHASES.findIndex(function (phase) { return phase.id === lower(project.phase); });
    refs.projectMeta.replaceChildren(fragment([
      metaCell('Название', project.name),
      metaCell('Путь копии', project.path || 'неизвестно', true, Boolean(project.path)),
      metaCell('Фаза', phaseIndex === -1 ? 'неизвестно' : PHASES[phaseIndex].label),
      metaCell('Состав', 'задач ' + project.tasks.length + ' · идей ' + project.ideas.length +
        ' · лабораторий ' + project.labs.length + ' · дизайнов ' + project.designs.length +
        ' · прогонов ' + project.runs.length)
    ]));
  }

  function renderPhases() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + project.phase : 'none';
    renderRegion('phases', refs.phasePath, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Фазы появятся после выбора проекта.');
      var current = PHASES.findIndex(function (phase) { return phase.id === lower(project.phase); });
      return PHASES.map(function (phase, index) {
        var state = current === -1 ? 'future' : (index < current ? 'done' : (index === current ? 'active' : 'future'));
        var stateText = current === -1 ? 'фаза не выбрана' : (state === 'done' ? 'пройдено' : (state === 'active' ? 'текущая' : 'впереди'));
        var button = el('button', {
          class: 'phase-button',
          attrs: { type: 'button', 'data-command': 'set-phase', 'data-phase': phase.id,
            title: 'Зафиксировать фазу: ' + phase.label }
        }, [
          el('span', { class: 'phase-num', text: String(index + 1).padStart(2, '0') }),
          el('span', { class: 'phase-label', text: phase.label }),
          el('span', { class: 'phase-state', text: stateText })
        ]);
        return el('li', { class: 'phase-step', data: { state: state } }, button);
      });
    });
  }

  function frontendTasks(project) {
    return project.tasks.filter(function (task) {
      var stage = lower(firstDefined(task, ['stage', 'track', 'lane', 'area', 'type']));
      return !stage || stage.indexOf('front') !== -1 || stage.indexOf('фронт') !== -1 ||
        stage.indexOf('ui') !== -1 || stage.indexOf('web') !== -1;
    });
  }

  function trackStat(value, label) {
    return el('div', { class: 'track-stat' }, [
      el('b', { text: String(value) }),
      el('span', { text: label })
    ]);
  }

  function renderTracks() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + JSON.stringify([project.tasks, project.labs]) : 'none';
    renderRegion('tracks', refs.frontendTrackBody, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Треки появятся после выбора проекта.');
      var tasks = frontendTasks(project);
      var active = tasks.filter(function (task) {
        var key = lower(firstDefined(task, ['status', 'state']));
        return key === 'in_progress' || key === 'active' || key === 'running';
      }).length;
      var blocked = tasks.filter(function (task) {
        return lower(firstDefined(task, ['status', 'state'])) === 'blocked';
      }).length;
      var unaccepted = tasks.filter(function (task) {
        var key = lower(firstDefined(task, ['status', 'state']));
        return ['done', 'completed', 'complete', 'finished', 'closed'].indexOf(key) !== -1 &&
          !decisionOf(project, task);
      }).length;
      return [
        el('div', { class: 'track-stats' }, [
          trackStat(tasks.length, 'задач'),
          trackStat(active, 'в работе'),
          trackStat(blocked, 'блокеры'),
          trackStat(unaccepted, 'без приёмки')
        ]),
        el('p', { class: 'track-state', text: tasks.length
          ? 'Детали и доказательства открываются по нажатию на задачу.'
          : 'Задачи интерфейса не зафиксированы.' })
      ];
    });

    renderRegion('labtrack', refs.labTrackBody, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Треки появятся после выбора проекта.');
      var phases = project.labs.map(function (lab) { return labPhase(project, lab); });
      function count(value) { return phases.filter(function (phase) { return phase === value; }).length; }
      var ready = phases.filter(function (phase) { return phase === 'ready'; }).length;
      var accepted = phases.filter(function (phase) { return phase === 'accepted'; }).length;
      return [
        el('div', { class: 'track-stats' }, [
          trackStat(project.labs.length, 'лабораторий'),
          trackStat(count('approved') + count('configured'), 'к демо'),
          trackStat(count('running') + ready, 'демо'),
          trackStat(accepted, 'принято')
        ]),
        el('p', { class: 'track-state', text: project.labs.length
          ? 'Приёмка фиксируется только явным решением после готового демо.'
          : 'Лабораторные гипотезы не предложены.' })
      ];
    });
  }

  function buildBlockers(project) {
    var result = [];
    if (!project) return result;
    var taskById = Object.create(null);
    project.tasks.forEach(function (task) { taskById[idOf(task)] = task; });

    project.tasks.forEach(function (task) {
      var status = lower(firstDefined(task, ['status', 'state']));
      var taskId = idOf(task) || 'без ID';
      if (status === 'blocked') {
        result.push({
          title: 'Задача ' + taskId + ' заблокирована',
          text: text(firstDefined(task, ['blocker', 'blockReason', 'evidence']), 'причина не указана'),
          tab: null
        });
      }
      stringList(firstDefined(task, ['dependsOn', 'dependencies'])).forEach(function (dependency) {
        var dep = taskById[dependency];
        if (!dep) {
          result.push({ title: 'Задача ' + taskId + ' ожидает неизвестную задачу', text: dependency, tab: null });
          return;
        }
        var depStatus = lower(firstDefined(dep, ['status', 'state']));
        var depDone = ['done', 'completed', 'complete', 'finished'].indexOf(depStatus) !== -1 || decisionOf(project, dep) === 'accepted';
        if (!depDone) {
          result.push({
            title: 'Задача ' + taskId + ' зависит от ' + dependency,
            text: 'статус зависимости: ' + statusLabel(depStatus, false),
            tab: null
          });
        }
      });
    });

    project.ideas.forEach(function (idea) {
      if (!decisionOf(project, idea)) {
        result.push({ title: 'Идея ' + (idOf(idea) || 'без ID') + ' ждёт решения', text: text(firstDefined(idea, ['text', 'title'])), tab: 'ideas' });
      }
    });

    project.labs.forEach(function (lab) {
      var phase = labPhase(project, lab);
      if (phase === 'proposed') {
        result.push({ title: 'Лаборатория ' + (idOf(lab) || 'без ID') + ' ждёт одобрения', text: text(firstDefined(lab, ['title'])), tab: 'labs' });
      } else if (phase === 'approved' || phase === 'configured') {
        if (!isLabConfigured(lab)) {
          result.push({ title: 'Демо лаборатории ' + (idOf(lab) || 'без ID') + ' не настроено', text: 'Требуются cwd, runtime, args и доказательство.', tab: 'labs' });
        }
      } else if (phase === 'ready') {
        result.push({ title: 'Лаборатория ' + (idOf(lab) || 'без ID') + ' готова к приёмке', text: 'Нужно явное решение: принять или запросить изменения.', tab: 'labs' });
      } else if (phase === 'unknown') {
        result.push({ title: 'Лаборатория ' + (idOf(lab) || 'без ID') + ': статус неизвестен', text: 'Действия заблокированы до явного статуса.', tab: 'labs' });
      }
    });

    project.designs.forEach(function (design) {
      var index = designStepIndex(design);
      if (index === null) {
        result.push({ title: 'Дизайн ' + (idOf(design) || 'без ID') + ': шаг неизвестен', text: 'Шаг не распознан, переход заблокирован.', tab: 'design' });
        return;
      }
      var step = DESIGN_STEPS[index + 1];
      if (!step) return;
      if (step.id === 'figma_ready') {
        result.push({ title: 'Дизайн ' + (idOf(design) || 'без ID') + ': ожидание синхронизации Figma', text: 'Синхронизация выполняется из Codex (design.figma.sync).', tab: 'design' });
      } else if (step.id === 'figma_approved') {
        if (designSyncProof(design)) {
          result.push({ title: 'Дизайн ' + (idOf(design) || 'без ID') + ': нужно решение человека', text: 'Следующий шаг: ' + step.label + '.', tab: 'design' });
        } else {
          result.push({ title: 'Дизайн ' + (idOf(design) || 'без ID') + ': требуется синхронизация Figma', text: 'Подтверждение доступно после сохранённой синхронизации из Codex.', tab: 'design' });
        }
      } else if (HUMAN_DESIGN_STEPS.indexOf(step.id) !== -1 || step.id === 'reviewed') {
        result.push({ title: 'Дизайн ' + (idOf(design) || 'без ID') + ': нужно решение человека', text: 'Следующий шаг: ' + step.label + '.', tab: 'design' });
      }
    });

    project.runs.forEach(function (run) {
      var key = lower(firstDefined(run, ['status', 'state']));
      if (key === 'failed' || key === 'error' || key === 'blocked') {
        result.push({ title: 'Прогон ' + (idOf(run) || 'без ID') + ': ' + statusLabel(key), text: text(firstDefined(run, ['error', 'note']), 'детали не указаны'), tab: 'git' });
      }
    });

    return result;
  }

  function renderBlockers() {
    var project = selectedProject();
    var items = buildBlockers(project);
    var stamp = project ? project.id + ':' + JSON.stringify(items) : 'none';
    renderRegion('blockers', refs.blockers, stamp, function () {
      if (!items.length) return emptyState('Активных блокеров нет', 'Основание: только явные статусы и решения из /api/state.');
      var shown = items.slice(0, 8).map(function (item) {
        var content = [
          el('span', { class: 'blocker-dot', attrs: { 'aria-hidden': 'true' } }),
          el('div', {}, [
            el('span', { class: 'blocker-title', text: item.title }),
            el('div', { class: 'blocker-text', text: item.text })
          ])
        ];
        if (item.tab) {
          content.push(el('button', {
            class: 'btn btn-ghost btn-small',
            text: 'Открыть',
            attrs: { type: 'button', 'data-command': 'goto-tab', 'data-tab': item.tab }
          }));
        }
        return el('div', { class: 'blocker-item' }, content);
      });
      if (items.length > shown.length) {
        shown.push(el('p', { class: 'action-note', text: 'И ещё ' + (items.length - shown.length) + ' блокеров в соответствующих разделах.' }));
      }
      return shown;
    });
  }

  function renderTasks() {
    var project = selectedProject();
    refs.taskCount.textContent = project ? String(project.tasks.length) : '—';
    var stamp = project ? project.id + ':' + JSON.stringify([project.tasks, project.decisions]) : 'none';
    renderRegion('tasks', refs.taskList, stamp, function () {
      if (!project) return emptyState('Нет задач', 'Выберите проект.');
      if (!project.tasks.length) return emptyState('Задачи не зафиксированы', 'Добавьте задачу через форму task.put.');
      return project.tasks.map(function (task) {
        var status = firstDefined(task, ['status', 'state']);
        var decision = decisionOf(project, task);
        var stage = firstDefined(task, ['stage', 'track', 'lane']);
        var meta = [];
        if (stage) meta.push(badge(String(stage), 'neutral'));
        meta.push(badge(statusLabel(status, decision === 'accepted'), statusTone(status, decision === 'accepted')));
        if (decision) meta.push(badge('решение: ' + DECISION_LABELS[decision], decision));
        if (firstDefined(task, ['agent'])) meta.push(el('span', { class: 'task-row-id', text: 'агент: ' + text(task.agent) }));
        if (firstDefined(task, ['model'])) meta.push(el('span', { class: 'task-row-id', text: 'модель: ' + text(task.model) }));
        if (firstDefined(task, ['sessionId'])) meta.push(el('span', { class: 'task-row-id', text: 'сессия: ' + text(task.sessionId) }));
        return el('button', {
          class: 'task-row',
          attrs: { type: 'button', 'data-command': 'open-task', 'data-id': idOf(task) }
        }, [
          el('span', {}, [
            el('span', { class: 'task-row-title', text: text(firstDefined(task, ['title', 'name']), 'Задача без названия') }),
            el('span', { class: 'task-row-id', text: 'ID: ' + (idOf(task) || 'неизвестно') })
          ]),
          el('span', { class: 'task-row-side' }, [
            el('span', { class: 'task-row-meta' }, meta),
            el('span', { class: 'task-row-id', text: 'Детали →' })
          ])
        ]);
      });
    });
  }

  function renderDecisions() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + JSON.stringify(project.decisions) : 'none';
    renderRegion('decisions', refs.decisionFeed, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Выберите проект.');
      if (!project.decisions.length) return emptyState('Решений нет', 'Завершённый прогон не считается принятым результатом.');
      return project.decisions.map(function (entry) {
        var key = decisionKey(firstDefined(entry, ['decision', 'status', 'outcome', 'result', 'value', 'type']));
        var target = firstDefined(entry, ['ideaId', 'labId', 'taskId', 'designId', 'targetId', 'itemId']);
        var note = firstDefined(entry, ['note', 'comment', 'reason', 'details']);
        var at = firstDefined(entry, ['at', 'createdAt', 'timestamp', 'time']);
        return el('article', { class: 'decision-item' }, [
          el('div', { class: 'decision-item-head' }, [
            badge(key ? (DECISION_LABELS[key] || key) : 'решение не распознано', key || 'unknown'),
            el('span', { class: 'decision-target', text: at ? text(at) : 'время неизвестно' })
          ]),
          el('div', { class: 'decision-target', text: 'объект: ' + (target ? text(target) : 'неизвестно') }),
          note ? el('p', { text: text(note) }) : null
        ]);
      });
    });
  }

  function collectLinks(source, out, seen, depth) {
    if (!source || typeof source !== 'object' || depth > 2) return;
    if (Array.isArray(source)) {
      source.forEach(function (entry) { collectLinks(entry, out, seen, depth + 1); });
      return;
    }
    Object.keys(source).forEach(function (key) {
      var value = source[key];
      var isLinkKey = /url|link|report|verif|preview|proof/i.test(key);
      if (typeof value === 'string' && value.trim() && (isLinkKey || /^https?:\/\//i.test(value.trim()))) {
        var label = LINK_LABELS[key] || key;
        var marker = label + '|' + value.trim();
        if (!seen[marker]) {
          seen[marker] = true;
          out.push({ label: label, value: value.trim() });
        }
      } else if (value && typeof value === 'object') {
        collectLinks(value, out, seen, depth + 1);
      }
    });
  }

  function runValue(project, keys) {
    for (var i = 0; i < project.runs.length; i += 1) {
      var direct = firstDefined(project.runs[i], keys);
      if (direct !== undefined) return direct;
      var nested = project.runs[i].git || project.runs[i].repository || {};
      var nestedValue = firstDefined(nested, keys);
      if (nestedValue !== undefined) return nestedValue;
    }
    return undefined;
  }

  function gitInfo(project) {
    var git = firstDefined(project.raw, ['git', 'gitInfo', 'repository', 'repo']) || {};
    return {
      branch: firstDefined(git, ['branch', 'ref', 'currentBranch', 'head']) || runValue(project, ['branch', 'ref', 'currentBranch']),
      sha: firstDefined(git, ['sha', 'commit', 'commitSha', 'headSha', 'revision']) || runValue(project, ['sha', 'commit', 'commitSha', 'revision']),
      path: firstDefined(git, ['copyPath', 'cwd', 'path', 'root']) || project.path || runValue(project, ['copyPath', 'cwd', 'path', 'root', 'workspace'])
    };
  }

  function linkCard(title, links, limit) {
    var rows = links.slice(0, limit || 8).map(function (entry) { return linkRow(entry.label, entry.value); });
    if (!rows.length) rows.push(el('p', { class: 'action-note', text: 'Ссылки не переданы — детали доступны в записях прогонов.' }));
    return el('article', { class: 'card' }, [
      el('div', { class: 'card-head' }, el('h3', { text: title })),
      el('div', { class: 'card-body link-list' }, rows)
    ]);
  }

  function renderGit() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + JSON.stringify([project.raw.git, project.runs, project.path]) : 'none';
    renderRegion('git', refs.gitContent, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Данные Git появятся после выбора проекта.');
      var info = gitInfo(project);
      var nodes = [el('article', { class: 'card' }, [
        el('div', { class: 'card-head' }, [
          el('h3', { text: 'Источник и рабочая копия' }),
          badge(PHASES.some(function (phase) { return phase.id === lower(project.phase); })
            ? PHASES.find(function (phase) { return phase.id === lower(project.phase); }).label
            : 'фаза неизвестна', project.phase ? 'active' : 'unknown')
        ]),
        el('div', { class: 'card-body' }, [
          kvGrid([
            kv('Ветка', info.branch || 'неизвестно', true),
            kv('SHA', info.sha || 'неизвестно', true),
            kv('Путь копии', info.path || 'неизвестно', true)
          ]),
          info.path ? el('div', { class: 'action-row' }, el('button', {
            class: 'btn btn-ghost btn-small',
            text: 'Копировать путь',
            attrs: { type: 'button', 'data-command': 'copy', 'data-copy': text(info.path) }
          })) : null
        ])
      ])];

      var links = [];
      var seen = Object.create(null);
      collectLinks(project.raw.git, links, seen, 0);
      project.runs.forEach(function (run) { collectLinks(run, links, seen, 0); });
      nodes.push(linkCard('Проверка и отчёты', links, 10));

      if (!project.runs.length) {
        nodes.push(emptyState('Прогонов нет', 'Идентификаторы воркеров и сессий появятся после регистрации прогонов.'));
        return nodes;
      }

      function appendRunCollections(body, run) {
        var workers = arrayOf(run.workers);
        if (workers.length) {
          body.push(el('h4', { class: 'card-subtitle', text: 'Воркеры' }));
          workers.forEach(function (worker, index) {
            var worktree = worker && typeof worker === 'object' && worker.worktree && typeof worker.worktree === 'object' ? worker.worktree : {};
            var workerId = idOf(worker);
            var title = text(firstDefined(worker, ['name', 'id']), 'Воркер ' + (index + 1));
            body.push(el('div', { class: 'run-worker' }, [
              el('p', { class: 'card-text', text: title }),
              el('div', { class: 'kv-grid' }, [
                workerId ? metaCell('ID', workerId, true, true) : null,
                metaCell('Имя', firstDefined(worker, ['name']), true, Boolean(firstDefined(worker, ['name']))),
                metaCell('Модель', firstDefined(worker, ['model']), true, Boolean(firstDefined(worker, ['model']))),
                kv('Статус', statusLabel(firstDefined(worker, ['status', 'state']), false)),
                metaCell('Путь', firstDefined(worker, ['path', 'cwd', 'copyPath']), true, Boolean(firstDefined(worker, ['path', 'cwd', 'copyPath']))),
                metaCell('ID дочерней сессии', firstDefined(worker, ['childSessionId', 'childSession', 'sessionId']), true, Boolean(firstDefined(worker, ['childSessionId', 'childSession', 'sessionId']))),
                kv('Ветка worktree', firstDefined(worktree, ['branch', 'ref']), true),
                kv('HEAD worktree', firstDefined(worktree, ['head', 'sha', 'commit']), true)
              ].filter(Boolean))
            ]));
          });
        }
        var assemblies = arrayOf(run.assemblies);
        if (assemblies.length) {
          body.push(el('h4', { class: 'card-subtitle', text: 'Сборки' }));
          assemblies.forEach(function (assembly, index) {
            var assemblyId = idOf(assembly);
            var verified = assembly && typeof assembly === 'object' && Object.prototype.hasOwnProperty.call(assembly, 'verified')
              ? assembly.verified
              : (assembly && typeof assembly === 'object' ? firstDefined(assembly, ['verified']) : undefined);
            var cells = [];
            if (assemblyId) cells.push(metaCell('ID', assemblyId, true, true));
            cells.push(kv('Идентификация', text(firstDefined(assembly, ['name', 'title', 'type', 'id']), assemblyId || ('Сборка ' + (index + 1)))));
            cells.push(kv('Проверено', verified === undefined || verified === null ? 'неизвестно' : (verified === true ? 'да' : (verified === false ? 'нет' : text(verified)))));
            if (assembly && typeof assembly === 'object') {
              ['worker', 'workerId', 'status', 'path', 'target'].forEach(function (key) {
                if (assembly[key] !== undefined && assembly[key] !== null && assembly[key] !== '') {
                  var copyable = key === 'workerId' || key === 'path';
                  if (copyable) cells.push(metaCell(key, assembly[key], true, true));
                  else cells.push(kv(key, assembly[key], true));
                }
              });
            }
            body.push(el('div', { class: 'run-assembly' }, el('div', { class: 'kv-grid' }, cells.filter(Boolean))));
          });
        }
      }

      project.runs.forEach(function (run) {
        var status = firstDefined(run, ['status', 'state']);
        var runId = idOf(run);
        var runLinks = [];
        collectLinks(run, runLinks, Object.create(null), 0);
        var body = [
          kvGrid([
            kv('ID прогона', runId || 'неизвестно', true),
            kv('Режим', firstDefined(run, ['mode']) || 'неизвестно', true),
            kv('Базовый SHA', firstDefined(run, ['baseSha', 'base_sha']) || 'неизвестно', true),
            kv('Воркер', firstDefined(run, ['workerId', 'worker', 'agent']) || 'неизвестно', true),
            kv('Сессия', firstDefined(run, ['sessionId', 'session']) || 'неизвестно', true),
            kv('Ветка', firstDefined(run, ['branch', 'ref']) || info.branch || 'неизвестно', true),
            kv('SHA', firstDefined(run, ['sha', 'commit', 'revision']) || info.sha || 'неизвестно', true),
            kv('Рабочая копия', firstDefined(run, ['cwd', 'copyPath', 'path']) || info.path || 'неизвестно', true),
            kv('Статус', statusLabel(status, false))
          ])
        ];
        if (runLinks.length) body.push(el('div', { class: 'link-list' }, runLinks.slice(0, 4).map(function (entry) {
          return linkRow(entry.label, entry.value);
        })));
        appendRunCollections(body, run);
        nodes.push(el('article', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h3', { text: 'Прогон ' + (runId || 'без ID') }),
            el('div', { class: 'action-row' }, [
              badge(statusLabel(status, false), statusTone(status, false)),
              el('button', {
                class: 'btn btn-ghost btn-small',
                text: 'Детали',
                attrs: { type: 'button', 'data-command': 'open-run', 'data-id': runId }
              })
            ])
          ]),
          el('div', { class: 'card-body' }, body)
        ]));
      });
      return nodes;
    });
  }

  function renderIdeas() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + JSON.stringify([project.ideas, project.decisions]) : 'none';
    renderRegion('ideas', refs.ideaList, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Выберите проект, чтобы работать с идеями.');
      if (!project.ideas.length) return emptyState('Идей нет', 'Новые идеи добавляются формой выше.');
      return project.ideas.map(function (idea) {
        var decision = decisionOf(project, idea);
        var buttons = [];
        if (!decision) {
          buttons = [
            el('button', { class: 'btn btn-emerald btn-small', text: 'Принять', attrs: { type: 'button', 'data-command': 'idea-decide', 'data-decision': 'accepted', 'data-id': idOf(idea) } }),
            el('button', { class: 'btn btn-danger btn-small', text: 'Отклонить', attrs: { type: 'button', 'data-command': 'idea-decide', 'data-decision': 'rejected', 'data-id': idOf(idea) } }),
            el('button', { class: 'btn btn-ghost btn-small', text: 'Отложить', attrs: { type: 'button', 'data-command': 'idea-decide', 'data-decision': 'deferred', 'data-id': idOf(idea) } })
          ];
        }
        return el('article', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h3', { text: text(firstDefined(idea, ['text', 'title']), 'Идея без текста') }),
            badge(decision ? 'решение: ' + DECISION_LABELS[decision] : 'решение не зафиксировано', decision || 'waiting')
          ]),
          el('div', { class: 'card-body' }, [
            kvGrid([
              kv('ID', idOf(idea) || 'неизвестно', true),
              kv('После задачи', firstDefined(idea, ['afterTaskId', 'afterTask']) || 'не указано', true),
              kv('Предложение', firstDefined(idea, ['proposal']) || 'не указано')
            ]),
            buttons.length ? el('div', { class: 'action-row' }, buttons) : el('p', { class: 'action-note', text: 'Решение уже зафиксировано и не переписывается дашбордом.' })
          ])
        ]);
      });
    });
  }

  function controlInput(id, name, draftKey, value, placeholder) {
    var control = el('input', { attrs: { type: 'text', id: id, name: name, placeholder: placeholder || '', spellcheck: 'false' } });
    control.value = value === undefined || value === null ? '' : String(value);
    if (draftKey) control.dataset.draftKey = draftKey;
    return control;
  }

  function controlTextarea(id, name, draftKey, value, rows, placeholder) {
    var control = el('textarea', { attrs: { id: id, name: name, rows: String(rows || 2), placeholder: placeholder || '', spellcheck: 'false' } });
    control.value = value === undefined || value === null ? '' : String(value);
    if (draftKey) control.dataset.draftKey = draftKey;
    return control;
  }

  function controlSelect(id, name, draftKey, options, value) {
    var control = el('select', { attrs: { id: id, name: name } });
    if (draftKey) control.dataset.draftKey = draftKey;
    options.forEach(function (option) {
      control.appendChild(el('option', { text: option.label, attrs: { value: option.value } }));
    });
    control.value = value === undefined || value === null ? '' : String(value);
    return control;
  }

  function formField(labelText, control, wide) {
    return el('div', { class: wide ? 'field field-wide' : 'field' }, [
      el('label', { text: labelText, attrs: { for: control.id } }),
      control
    ]);
  }

  function labPhaseLabel(phase) {
    var labels = {
      proposed: 'предложено',
      approved: 'одобрено',
      configured: 'настроено',
      running: 'запущено',
      ready: 'готово к приёмке',
      accepted: 'принято',
      changes_requested: 'запрошены изменения',
      rejected: 'отклонено',
      unknown: 'статус неизвестен'
    };
    return labels[phase] || 'статус неизвестен';
  }

  function labTone(phase) {
    if (phase === 'accepted' || phase === 'ready') return 'accepted';
    if (phase === 'approved' || phase === 'configured') return 'active';
    if (phase === 'running') return 'active';
    if (phase === 'rejected') return 'blocked';
    if (phase === 'changes_requested' || phase === 'deferred') return 'waiting';
    return 'unknown';
  }

  function renderLabs() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + JSON.stringify([project.labs, project.decisions]) : 'none';
    renderRegion('labs', refs.labList, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Выберите проект.');
      if (!project.labs.length) return emptyState('Лабораторий нет', 'Предложите гипотезу формой выше.');
      return project.labs.map(function (lab) {
        var id = idOf(lab);
        var phase = labPhase(project, lab);
        var decision = decisionOf(project, lab);
        var config = labConfig(lab);
        var cwd = firstDefined(config, ['cwd', 'path', 'root']);
        var configRuntime = firstDefined(config, ['runtime']);
        var args = firstDefined(config, ['args']);
        var evidence = firstDefined(config, ['evidence']);
        var execution = labRuntime(lab);
        var running = labProcessRunning(lab);
        var port = labDemoPort(lab);
        var verified = labDecisionReady(lab);
        var actions = [];
        var notes = [];

        if (phase === 'proposed') {
          actions.push(el('button', { class: 'btn btn-emerald btn-small', text: 'Одобрить', attrs: { type: 'button', 'data-command': 'lab-decide', 'data-decision': 'approved', 'data-id': id } }));
          actions.push(el('button', { class: 'btn btn-danger btn-small', text: 'Отклонить', attrs: { type: 'button', 'data-command': 'lab-decide', 'data-decision': 'rejected', 'data-id': id } }));
        } else if (phase === 'unknown') {
          notes.push('Состояние лаборатории неизвестно — переходы заблокированы.');
        }

        if (labStartAllowed(lab)) {
          actions.push(el('button', { class: 'btn btn-emerald btn-small', text: 'Запустить демо', attrs: { type: 'button', 'data-command': 'lab-start', 'data-id': id } }));
        } else if (['configured', 'ready'].indexOf(phase) !== -1 && !running) {
          notes.push('Запуск заблокирован: backend разрешает запуск только из состояния configured/ready при настроенном демо.');
        }

        // runtime=ready и runtime=running — живой процесс, Stop доступен в обоих случаях.
        if (running) {
          actions.push(el('button', { class: 'btn btn-danger btn-small', text: 'Остановить демо', attrs: { type: 'button', 'data-command': 'lab-stop', 'data-id': id } }));
        }
        if (labDemoOpenAllowed(lab)) {
          actions.push(el('a', {
            class: 'btn btn-ghost btn-small',
            text: 'Открыть демо',
            attrs: { href: 'http://127.0.0.1:' + port + '/', target: '_blank', rel: 'noopener noreferrer' }
          }));
        } else if (execution === 'ready') {
          notes.push('Ссылка недоступна: сервер не передал корректный lastRun.port.');
        }

        if (verified && decision !== 'accepted' && decision !== 'changes_requested' && decision !== 'rejected') {
          actions.push(el('button', { class: 'btn btn-emerald btn-small', text: 'Принять демо', attrs: { type: 'button', 'data-command': 'lab-decide', 'data-decision': 'accepted', 'data-id': id } }));
          actions.push(el('button', { class: 'btn btn-ghost btn-small', text: 'Запросить изменения', attrs: { type: 'button', 'data-command': 'lab-decide', 'data-decision': 'changes_requested', 'data-id': id } }));
        } else if (!verified && ['configured', 'ready'].indexOf(phase) !== -1 && decision !== 'accepted' && decision !== 'changes_requested') {
          notes.push('Приёмка заблокирована: backend требует readySeen и lastRun.status="ready".');
        }

        var body = [
          kvGrid([
            kv('ID', id || 'неизвестно', true),
            kv('Фаза', labPhaseLabel(phase)),
            kv('Исполнение', execution || 'неизвестно', true),
            kv('Процесс', running ? 'запущен' : 'не запущен'),
            kv('Готовность демо', verified ? 'подтверждена' : 'не подтверждена'),
            kv('Порт демо', port === null ? 'неизвестно' : String(port), true),
            kv('CWD', cwd || 'неизвестно', true),
            kv('Среда демо', configRuntime || 'неизвестно', true),
            kv('Аргументы', formatArgs(args) || 'неизвестно', true),
            kv('Доказательство настройки', evidence || 'неизвестно')
          ]),
          el('p', { class: 'card-text', text: text(firstDefined(lab, ['scenario']), 'Сценарий не указан') }),
          linesBlock('Критерии', firstDefined(lab, ['criteria'])),
          linesBlock('Модули', firstDefined(lab, ['modulePaths', 'modules'])),
          linesBlock('Файлы демо', firstDefined(lab, ['demoPaths', 'demo'])),
          firstDefined(lab, ['proof']) ? el('p', { class: 'card-text', text: 'Доказательство: ' + text(lab.proof) }) : null
        ];

        if (notes.length) {
          body.push(el('div', {}, notes.map(function (note) { return el('p', { class: 'action-note', text: note }); })));
        }
        if (actions.length) body.push(el('div', { class: 'action-row' }, actions));

        if (phase === 'approved' || phase === 'configured') {
          var form = el('form', { class: 'inline-form', attrs: { 'data-action-form': 'lab-configure', 'data-id': id } }, [
            formField('CWD демо', controlInput('lab-cwd-' + id, 'cwd', 'lab:' + id + ':cwd', cwd, 'C:\\work\\demo'), true),
            formField('Runtime', controlSelect('lab-runtime-' + id, 'runtime', 'lab:' + id + ':runtime', [
              { value: '', label: 'не выбран' },
              { value: 'node', label: 'node' },
              { value: 'python', label: 'python' }
            ], configRuntime)),
            formField('Аргументы', controlInput('lab-args-' + id, 'args', 'lab:' + id + ':args', formatArgs(args), '--flag "значение"'), true),
            formField('Доказательство настройки', controlTextarea('lab-evidence-' + id, 'evidence', 'lab:' + id + ':evidence', evidence, 2, 'Команда и ожидаемый observable-результат'), true)
          ]);
          var submit = el('button', { class: 'btn btn-primary btn-small', text: 'Сохранить настройки демо', attrs: { type: 'button' } });
          submit.setAttribute('type', 'submit');
          form.appendChild(el('div', { class: 'form-actions' }, submit));
          body.push(form);
        }

        return el('article', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h3', { text: text(firstDefined(lab, ['title', 'name']), 'Лаборатория без названия') }),
            el('div', { class: 'action-row' }, [
              badge(labPhaseLabel(phase), labTone(phase)),
              decision ? badge('решение: ' + DECISION_LABELS[decision], decision) : null,
              el('span', { class: 'card-id', text: 'ID: ' + (id || 'неизвестно') })
            ])
          ]),
          el('div', { class: 'card-body' }, body)
        ]);
      });
    });
  }

  function designStepFields(stepId) {
    var map = {
      references_ready: ['Ссылки на исходные материалы', 'Комментарий (необязательно)'],
      references_approved: ['Артефакт (необязательно)', 'Явное решение человека (необязательно)'],
      figma_approved: ['Артефакт (необязательно)', 'Явное решение человека (необязательно)'],
      implemented: ['Артефакт / путь реализации', 'Комментарий (необязательно)'],
      reviewed: ['Доказательства проверки', 'Итог проверки (необязательно)']
    };
    return map[stepId] || ['Артефакт', 'Примечание'];
  }

  function designBlockReason(project, design, stepId) {
    if (stepId === 'figma_approved' && !designSyncProof(design)) {
      return 'Подтверждение Figma доступно только после сохранённой синхронизации из Codex (design.figma.sync).';
    }
    return '';
  }

  function validateAdvance(stepId, artifact, note, frames, project, design) {
    var block = designBlockReason(project, design, stepId);
    if (block) return block;
    if (stepId === 'figma_ready') return 'Шаг figma_ready выполняется только через синхронизацию Figma из Codex.';
    if (stepId === 'references_ready') {
      if (!artifact.trim()) return 'Укажите ссылки на исходные материалы.';
      if (!looksLikeLink(artifact)) return 'В артефакте нужна http(s)-ссылка или путь к файлу.';
    }
    if (stepId === 'implemented' && !artifact.trim()) return 'Укажите артефакт реализации.';
    if (stepId === 'reviewed' && !artifact.trim()) return 'Укажите доказательства проверки.';
    // Для human-шагов Store требует только явного решения в браузере: note необязателен.
    return '';
  }

  function renderSyncFrames(frames) {
    var list = arrayOf(frames);
    if (!list.length) return null;
    var hasObjects = list.some(function (item) { return item && typeof item === 'object' && !Array.isArray(item) && (item.nodeId || item.url); });
    if (!hasObjects) return linesBlock('Фреймы', frames);
    return el('div', {}, [
      el('p', { class: 'card-text', text: 'Фреймы' }),
      el('ul', { class: 'list-lines' }, list.map(function (item) {
        if (!item || typeof item !== 'object') return el('li', { text: text(item, '') });
        var label = text(firstDefined(item, ['name', 'title']), 'Фрейм');
        var nodeId = firstDefined(item, ['nodeId', 'id']);
        var url = firstDefined(item, ['url', 'href', 'link']);
        var parts = [el('span', { text: label })];
        if (nodeId) parts.push(el('span', { class: 'value mono', text: ' · nodeId: ' + text(nodeId) }));
        if (url) parts.push(el('div', {}, linkRow('Ссылка', url)));
        return el('li', {}, parts);
      }))
    ]);
  }

  function designHistoryBlock(design) {
    var history = arrayOf(design.history);
    if (!history.length) {
      return el('p', { class: 'action-note', text: 'История шагов пуста: сервер ждёт первый шаг «Источники готовы».' });
    }
    return el('div', { class: 'history-list' }, history.map(function (entry, position) {
      var stepId = lower(firstDefined(entry, ['step', 'id', 'to']));
      var artifact = firstDefined(entry, ['artifact', 'artifactPath', 'url', 'fileUrl']);
      var noteValue = firstDefined(entry, ['note', 'evidence']);
      var frames = firstDefined(entry, ['frames', 'frameList']);
      var fileKey = firstDefined(entry, ['fileKey']);
      var verified = firstDefined(entry, ['verified']);
      var infoCells = [
        kv('Источник', firstDefined(entry, ['source', 'actor', 'by']) || 'неизвестно', true),
        kv('Время', firstDefined(entry, ['ts', 'timestamp', 'createdAt', 'at']) || 'неизвестно', true)
      ];
      if (fileKey) infoCells.push(kv('Ключ файла', fileKey, true));
      if (verified === true) infoCells.push(kv('Проверка', 'подтверждена (MCP)'));
      var nodes = [
        el('div', { class: 'history-head' }, [
          badge(designStepLabel(stepId), stepId.indexOf('figma_') === 0 ? 'active' : 'complete'),
          el('span', { class: 'action-note', text: 'запись ' + (position + 1) })
        ]),
        kvGrid(infoCells),
        linkRow('Артефакт', artifact)
      ];
      var frameNodes = renderSyncFrames(frames);
      if (frameNodes) nodes.push(frameNodes);
      if (noteValue !== undefined && noteValue !== null && noteValue !== '') {
        nodes.push(el('p', { class: 'card-text', text: text(noteValue) }));
      }
      return el('div', { class: 'history-entry' }, nodes);
    }));
  }

  function renderDesigns() {
    var project = selectedProject();
    var stamp = project ? project.id + ':' + JSON.stringify(project.designs) : 'none';
    renderRegion('designs', refs.designList, stamp, function () {
      if (!project) return emptyState('Нет проекта', 'Выберите проект.');
      if (!project.designs.length) return [emptyState('Дизайнов нет', 'Создайте дизайн формой выше.')];
      return project.designs.map(function (design) {
        var id = idOf(design);
        var index = designStepIndex(design);
        var current = index === null ? null : (index >= 0 ? DESIGN_STEPS[index] : { id: 'created', label: 'создано' });
        var proof = designSyncProof(design);
        var chips = DESIGN_STEPS.map(function (step, stepIndex) {
          var state = index === null ? 'future' : (stepIndex < index ? 'done' : (stepIndex === index ? 'active' : 'future'));
          if (step.id === 'figma_ready' && index === 1) state = 'waiting';
          if (step.id === 'figma_approved' && index === 2 && !proof) state = 'blocked';
          return el('span', { class: 'step-chip', text: String(stepIndex + 1) + ' · ' + step.label, data: { state: state } });
        });
        var body = [
          el('div', { class: 'step-track' }, chips),
          kvGrid([
            kv('ID', id || 'неизвестно', true),
            kv('Текущий шаг', current ? current.label : 'неизвестно'),
            kv('Индекс шага', index === null ? 'неизвестно' : String(index), true),
            kv('Синхронизация Figma', proof ? 'сохранена (MCP)' : (index >= 2 ? 'не сохранена' : 'ожидается')),
            kv('Обновлено', firstDefined(design, ['updatedAt']) || 'неизвестно', true)
          ])
        ];

        var nextId = expectedDesignStep(design);
        if (index === null) {
          body.push(el('p', { class: 'action-note', text: 'Текущий шаг неизвестен: переход заблокирован, чтобы не пропустить подтверждения человека.' }));
        } else if (nextId === 'figma_ready') {
          body.push(el('p', { class: 'action-note', text: 'Ожидание синхронизации из Codex. Шаг figma_ready выполняется действием design.figma.sync (CLI), ручной ввод отключён.' }));
        } else if (proof && index >= 2) {
          body.push(el('div', { class: 'history-entry' }, [
            el('p', { class: 'card-text', text: 'Сохранённая синхронизация Figma (Codex):' }),
            kvGrid([
              kv('Ключ файла', firstDefined(proof, ['fileKey']) || 'неизвестно', true),
              kv('Проверка', 'подтверждена', true)
            ]),
            linkRow('Файл Figma', firstDefined(proof, ['fileUrl', 'artifact'])),
            renderSyncFrames(firstDefined(proof, ['frames'])) || null
          ].filter(Boolean)));
          if (index === 2) {
            var approveForm = el('form', { class: 'inline-form', attrs: { 'data-action-form': 'design-advance', 'data-id': id, 'data-step': 'figma_approved' } }, [
              formField('Примечание (необязательно)', controlTextarea('design-note-' + id, 'note', 'design:' + id + ':note', '', 2, 'Явное решение человека'), true)
            ]);
            approveForm.appendChild(el('div', { class: 'form-actions' }, [
              el('button', { class: 'btn btn-primary btn-small', text: 'Подтвердить Figma (второе решение)', attrs: { type: 'submit' } }),
              el('p', { class: 'hint', text: 'Отправка формы фиксирует явное решение человека; примечание необязательно.' })
            ]));
            body.push(approveForm);
          }
        } else if (index === 2 && !proof) {
          body.push(el('p', { class: 'action-note', text: 'Ожидание синхронизации из Codex. Подтверждение Figma станет доступно после сохранённой синхронизации (design.figma.sync).' }));
        } else if (!nextId) {
          body.push(el('p', { class: 'action-note', text: 'Все шаги пройдены. Дальнейших автоматических действий нет.' }));
        } else {
          var next = DESIGN_STEPS[indexOfStep(nextId)];
          var labels = designStepFields(nextId);
          var isHumanDesignStep = HUMAN_DESIGN_STEPS.indexOf(nextId) !== -1;
          var fields = [];
          if (!isHumanDesignStep) {
            fields.push(formField(labels[0], controlTextarea('design-artifact-' + id, 'artifact', 'design:' + id + ':artifact',
              '', 2, 'Ссылка или путь'), true));
          }
          fields.push(formField(labels[1] || 'Примечание (необязательно)', controlTextarea('design-note-' + id, 'note', 'design:' + id + ':note',
            '', 2, isHumanDesignStep ? 'Явное решение человека' : 'Основание шага'), true));
          var form = el('form', { class: 'inline-form', attrs: { 'data-action-form': 'design-advance', 'data-id': id, 'data-step': nextId } }, fields);
          var buttonLabel = isHumanDesignStep
            ? (nextId === 'references_approved' ? 'Принять источники (первое решение)' : 'Подтвердить: ' + next.label)
            : 'Перейти: ' + next.label;
          form.appendChild(el('div', { class: 'form-actions' }, [
            el('button', { class: 'btn btn-primary btn-small', text: buttonLabel, attrs: { type: 'submit' } }),
            el('p', { class: 'hint', text: isHumanDesignStep
              ? 'Отправка формы фиксирует явное решение человека; примечание необязательно.'
              : 'Шаг сохраняется только после явной отправки формы.' })
          ]));
          body.push(form);
        }

        body.push(el('section', { class: 'history-section' }, [
          el('h4', { class: 'history-title', text: 'История шагов' }),
          designHistoryBlock(design)
        ]));

        return el('article', { class: 'card' }, [
          el('div', { class: 'card-head' }, [
            el('h3', { text: text(firstDefined(design, ['title', 'name']), 'Дизайн без названия') }),
            badge(current ? current.label : 'шаг неизвестно', current ? 'active' : 'unknown')
          ]),
          el('div', { class: 'card-body' }, body)
        ]);
      });
    });
  }

  function detailSection(title, nodes) {
    return el('section', { class: 'dialog-section' }, [el('h3', { text: title })].concat((nodes || []).filter(Boolean)));
  }

  function openTaskDetail(id) {
    var project = selectedProject();
    if (!project) return;
    var task = project.tasks.find(function (entry) { return idOf(entry) === id; });
    refs.detailKind.textContent = 'Задача · ID ' + (id || 'неизвестно');
    if (!task) {
      refs.detailTitle.textContent = 'Задача не найдена';
      refs.detailBody.replaceChildren(emptyState('Запись не найдена', 'Проверьте ID и состояние проекта.'));
      if (!refs.detailDialog.open) refs.detailDialog.showModal();
      return;
    }
    var status = firstDefined(task, ['status', 'state']);
    var decision = decisionOf(project, task);
    refs.detailTitle.textContent = text(firstDefined(task, ['title', 'name']), 'Задача без названия');
    var sections = [
      detailSection('Состояние', kvGrid([
        kv('ID', idOf(task) || 'неизвестно', true),
        kv('Статус', statusLabel(status, decision === 'accepted')),
        kv('Явное решение', decision ? DECISION_LABELS[decision] : 'не зафиксировано'),
        kv('Этап / трек', firstDefined(task, ['stage', 'track', 'lane']) || 'неизвестно'),
        kv('Обновлено', firstDefined(task, ['updatedAt', 'at', 'timestamp']) || 'неизвестно')
      ])),
      detailSection('Исполнение', kvGrid([
        kv('Агент', firstDefined(task, ['agent', 'workerId']) || 'неизвестно', true),
        kv('Модель', firstDefined(task, ['model']) || 'неизвестно', true),
        kv('ID прогона', firstDefined(task, ['runId']) || 'неизвестно', true),
        kv('ID сессии', firstDefined(task, ['sessionId']) || 'неизвестно', true)
      ]))
    ];
    sections.push(detailSection('Критерии', linesBlock('Критерии приёмки', firstDefined(task, ['criteria'])) || el('p', { class: 'action-note', text: 'Критерии не переданы.' })));
    sections.push(detailSection('Доказательства', linesBlock('Доказательства', firstDefined(task, ['evidence'])) || el('p', { class: 'action-note', text: 'Доказательства не переданы.' })));
    if (task && typeof task === 'object' && Object.prototype.hasOwnProperty.call(task, 'acceptanceEvidence')) {
      var acceptanceEvidence = task.acceptanceEvidence;
      var acceptanceNode;
      if (acceptanceEvidence === undefined || acceptanceEvidence === null || acceptanceEvidence === '') {
        acceptanceNode = el('p', { class: 'action-note', text: text(acceptanceEvidence) });
      } else if (Array.isArray(acceptanceEvidence)) {
        acceptanceNode = linesBlock('Доказательства приёмки', acceptanceEvidence) || el('p', { class: 'action-note', text: '[]' });
      } else if (typeof acceptanceEvidence === 'object') {
        acceptanceNode = el('pre', { class: 'value mono', text: JSON.stringify(acceptanceEvidence, null, 2) });
      } else {
        acceptanceNode = el('p', { class: 'card-text mono', text: String(acceptanceEvidence) });
      }
      sections.push(detailSection('Доказательства приёмки', acceptanceNode));
    }

    var dependencies = stringList(firstDefined(task, ['dependsOn', 'dependencies']));
    if (dependencies.length) {
      var dependencyCells = dependencies.map(function (dependency) {
        var dep = project.tasks.find(function (entry) { return idOf(entry) === dependency; });
        return kv(dependency, dep ? statusLabel(firstDefined(dep, ['status', 'state']), decisionOf(project, dep) === 'accepted') : 'задача не найдена', true);
      });
      sections.push(detailSection('Зависимости', kvGrid(dependencyCells)));
    }

    var runId = idOf(firstDefined(task, ['runId']));
    var run = runId ? project.runs.find(function (entry) { return idOf(entry) === runId; }) : null;
    if (run) {
      sections.push(detailSection('Связанный прогон', [
        kvGrid([
          kv('ID', idOf(run) || 'неизвестно', true),
          kv('Статус', statusLabel(firstDefined(run, ['status', 'state']), false)),
          kv('Воркер', firstDefined(run, ['workerId', 'worker', 'agent']) || 'неизвестно', true),
          kv('Сессия', firstDefined(run, ['sessionId']) || 'неизвестно', true)
        ]),
        el('button', {
          class: 'btn btn-ghost btn-small',
          text: 'Открыть детали прогона',
          attrs: { type: 'button', 'data-command': 'open-run', 'data-id': idOf(run) }
        })
      ]));
    }

    var known = Object.keys(task).map(function (key) { return kv(key, task[key], true); });
    if (known.length) sections.push(detailSection('Все известные поля', kvGrid(known)));
    refs.detailBody.replaceChildren(fragment(sections));
    if (!refs.detailDialog.open) refs.detailDialog.showModal();
  }

  function openRunDetail(id) {
    var project = selectedProject();
    if (!project) return;
    var run = project.runs.find(function (entry) { return idOf(entry) === id; });
    refs.detailKind.textContent = 'Прогон · ID ' + (id || 'неизвестно');
    if (!run) {
      refs.detailTitle.textContent = 'Прогон не найден';
      refs.detailBody.replaceChildren(emptyState('Запись не найдена', 'Проверьте ID и состояние проекта.'));
      if (!refs.detailDialog.open) refs.detailDialog.showModal();
      return;
    }
    var status = firstDefined(run, ['status', 'state']);
    var info = gitInfo(project);
    refs.detailTitle.textContent = text(firstDefined(run, ['title', 'name', 'workerId']), 'Прогон без названия');
    var links = [];
    collectLinks(run, links, Object.create(null), 0);
    var sections = [
      detailSection('Идентификация', kvGrid([
        kv('ID прогона', idOf(run) || 'неизвестно', true),
        kv('Воркер', firstDefined(run, ['workerId', 'worker', 'agent']) || 'неизвестно', true),
        kv('Сессия', firstDefined(run, ['sessionId', 'session']) || 'неизвестно', true),
        kv('Статус', statusLabel(status, false)),
        kv('Приёмка', 'не выводится по статусу прогона')
      ])),
      detailSection('Git и копия', kvGrid([
        kv('Ветка', firstDefined(run, ['branch', 'ref']) || info.branch || 'неизвестно', true),
        kv('SHA', firstDefined(run, ['sha', 'commit', 'revision']) || info.sha || 'неизвестно', true),
        kv('Путь копии', firstDefined(run, ['cwd', 'copyPath', 'path']) || info.path || 'неизвестно', true)
      ]))
    ];
    if (links.length) {
      sections.push(detailSection('Ссылки', el('div', { class: 'link-list' }, links.slice(0, 8).map(function (entry) {
        return linkRow(entry.label, entry.value);
      }))));
    }
    var known = Object.keys(run).map(function (key) { return kv(key, run[key], true); });
    if (known.length) sections.push(detailSection('Все известные поля', kvGrid(known)));
    refs.detailBody.replaceChildren(fragment(sections));
    if (!refs.detailDialog.open) refs.detailDialog.showModal();
  }

  function notify(message, kind) {
    if (!refs.toast) return;
    refs.toast.textContent = String(message);
    refs.toast.dataset.kind = kind === 'error' ? 'error' : 'ok';
    refs.toast.hidden = false;
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { refs.toast.hidden = true; }, kind === 'error' ? 7000 : 4200);
  }

  function renderAll() {
    renderStatus();
    renderProjectOptions();
    renderProjectMeta();
    renderPhases();
    renderTracks();
    renderBlockers();
    renderTasks();
    renderDecisions();
    renderGit();
    renderIdeas();
    renderLabs();
    renderDesigns();
  }

  function loadState() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch('/api/state', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        applyState(data);
        renderAll();
      })
      .catch(function (error) {
        view.connected = false;
        renderStatus();
        if (!view.raw) notify('Не удалось получить состояние: ' + error.message, 'error');
      })
      .then(function () { loadPromise = null; });
    return loadPromise;
  }

  function pollLoop() {
    loadState();
    window.setTimeout(pollLoop, 2000);
  }

  function sendAction(payload, button, successMessage) {
    var project = selectedProject();
    if (payload.projectId === undefined && payload.action !== 'project.add') {
      if (!project) { notify('Выберите проект.', 'error'); return Promise.resolve(false); }
      payload.projectId = project.id;
    }
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    return fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().then(function (body) { return { response: response, body: body }; })
          .catch(function () { return { response: response, body: null }; });
      })
      .then(function (result) {
        var body = result.body;
        if (!result.response.ok || !body || body.error || body.ok !== true) {
          throw new Error(body && body.error ? body.error : 'HTTP ' + result.response.status);
        }
        if (body.project && idOf(body.project)) view.selectedId = idOf(body.project);
        if (payload.action === 'project.add' && body.id) view.selectedId = idOf(body.id);
        resetSignatures();
        notify(successMessage || 'Действие выполнено.');
        return loadState();
      })
      .catch(function (error) {
        notify('Ошибка действия: ' + error.message, 'error');
        return false;
      })
      .then(function (result) {
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        return result;
      });
  }

  function formValue(form, name) {
    var control = form.elements[name];
    return control ? String(control.value || '').trim() : '';
  }

  function copyText(value, button) {
    if (!value) { notify('Путь неизвестен — копировать нечего.', 'error'); return; }
    function done() {
      notify('Путь скопирован.');
      if (button) {
        var original = button.textContent;
        button.textContent = 'Скопировано';
        window.setTimeout(function () { button.textContent = original; }, 1400);
      }
    }
    function fallback() {
      var area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (ignored) { copied = false; }
      area.remove();
      if (copied) done(); else notify('Не удалось скопировать путь.', 'error');
    }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(value).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  function setTab(name) {
    activeTab = name;
    var tabs = document.querySelectorAll('[role="tab"][data-tab]');
    for (var i = 0; i < tabs.length; i += 1) {
      var on = tabs[i].dataset.tab === name;
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
      tabs[i].tabIndex = on ? 0 : -1;
    }
    var panels = document.querySelectorAll('[data-tab-panel]');
    for (var j = 0; j < panels.length; j += 1) {
      panels[j].hidden = panels[j].dataset.tabPanel !== name;
    }
  }

  function handleSubmit(event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    var kind = form.dataset.actionForm || form.id;
    var button = form.querySelector('button[type="submit"]');
    var project = selectedProject();

    if (kind === 'projectForm') {
      var name = formValue(form, 'name');
      var path = formValue(form, 'path');
      if (!name || !path) { notify('Укажите название и путь проекта.', 'error'); return; }
      sendAction({ action: 'project.add', name: name, path: path }, button, 'Проект зарегистрирован.')
        .then(function (result) { if (result !== false) form.reset(); });
      return;
    }

    if (!project) { notify('Выберите проект.', 'error'); return; }

    if (kind === 'taskForm') {
      var taskId = formValue(form, 'id');
      var title = formValue(form, 'title');
      if (!taskId || !title) { notify('Укажите ID и заголовок задачи.', 'error'); return; }
      var payload = {
        action: 'task.put',
        id: taskId,
        title: title,
        stage: formValue(form, 'stage'),
        status: formValue(form, 'status')
      };
      ['agent', 'model', 'runId', 'sessionId'].forEach(function (field) {
        var value = formValue(form, field);
        if (value) payload[field] = value;
      });
      var criteria = parseList(formValue(form, 'criteria'));
      var evidence = parseList(formValue(form, 'evidence'));
      var dependsOn = parseList(formValue(form, 'dependsOn'));
      if (criteria.length) payload.criteria = criteria;
      if (evidence.length) payload.evidence = evidence;
      if (dependsOn.length) payload.dependsOn = dependsOn;
      sendAction(payload, button, 'Задача сохранена.').then(function (result) { if (result !== false) form.reset(); });
      return;
    }

    if (kind === 'ideaForm') {
      var ideaText = formValue(form, 'text');
      if (!ideaText) { notify('Введите текст идеи.', 'error'); return; }
      var ideaPayload = { action: 'idea.add', text: ideaText };
      var proposal = formValue(form, 'proposal');
      var afterTaskId = formValue(form, 'afterTaskId');
      if (proposal) ideaPayload.proposal = proposal;
      if (afterTaskId) ideaPayload.afterTaskId = afterTaskId;
      sendAction(ideaPayload, button, 'Идея отправлена.').then(function (result) { if (result !== false) form.reset(); });
      return;
    }

    if (kind === 'labForm') {
      var labTitle = formValue(form, 'title');
      var scenario = formValue(form, 'scenario');
      if (!labTitle || !scenario) { notify('Укажите название и сценарий лаборатории.', 'error'); return; }
      var labPayload = {
        action: 'lab.propose',
        title: labTitle,
        scenario: scenario,
        criteria: parseList(formValue(form, 'criteria')),
        modulePaths: parseList(formValue(form, 'modulePaths')),
        demoPaths: parseList(formValue(form, 'demoPaths'))
      };
      var proof = formValue(form, 'proof');
      if (proof) labPayload.proof = proof;
      sendAction(labPayload, button, 'Лаборатория предложена.').then(function (result) { if (result !== false) form.reset(); });
      return;
    }

    if (kind === 'designForm') {
      var designTitle = formValue(form, 'title');
      if (!designTitle) { notify('Укажите название дизайна.', 'error'); return; }
      sendAction({ action: 'design.create', title: designTitle }, button, 'Дизайн создан.')
        .then(function (result) { if (result !== false) form.reset(); });
      return;
    }

    if (kind === 'lab-configure') {
      var labId = form.dataset.id;
      var lab = project.labs.find(function (entry) { return idOf(entry) === labId; });
      var phase = lab ? labPhase(project, lab) : 'unknown';
      if (!lab || (phase !== 'approved' && phase !== 'configured')) {
        notify('Настройка демо доступна только после одобрения лаборатории.', 'error');
        return;
      }
      var cwd = formValue(form, 'cwd');
      var runtime = formValue(form, 'runtime');
      var evidence = formValue(form, 'evidence');
      if (!cwd || (runtime !== 'node' && runtime !== 'python') || !evidence) {
        notify('Укажите cwd, runtime (node или python) и доказательство настройки.', 'error');
        return;
      }
      sendAction({
        action: 'lab.configure', id: labId, cwd: cwd, runtime: runtime,
        args: parseArgs(formValue(form, 'args')), evidence: evidence
      }, button, 'Настройки демо сохранены.');
      return;
    }

    if (kind === 'design-advance') {
      var designId = form.dataset.id;
      var step = form.dataset.step;
      var design = project.designs.find(function (entry) { return idOf(entry) === designId; });
      // stepIndex = -1 у только что созданного дизайна: ожидается переход -1 → 0.
      var expected = design ? expectedDesignStep(design) : null;
      if (!design || expected !== step) {
        notify('Шаг устарел: обновите состояние и повторите.', 'error');
        return;
      }
      var artifact = formValue(form, 'artifact');
      var note = formValue(form, 'note');
      var problem = validateAdvance(step, artifact, note, [], project, design);
      if (problem) { notify(problem, 'error'); return; }
      var payload = { action: 'design.advance', id: designId, step: step };
      if (artifact) payload.artifact = artifact;
      if (note) payload.note = note;
      var success = (step === 'references_approved' || step === 'figma_approved')
        ? 'Решение сохранено.'
        : 'Шаг дизайна сохранён.';
      sendAction(payload, button, success);
    }
  }

  function handleClick(event) {
    var tab = event.target.closest('[role="tab"][data-tab]');
    if (tab) { setTab(tab.dataset.tab); return; }
    var button = event.target.closest('[data-command]');
    if (!button) return;
    var command = button.dataset.command;
    var id = button.dataset.id;
    var project = selectedProject();

    if (command === 'refresh') { loadState(); return; }
    if (command === 'copy') { copyText(button.dataset.copy, button); return; }
    if (command === 'goto-tab') { setTab(button.dataset.tab); return; }
    if (command === 'close-detail') { refs.detailDialog.close(); return; }
    if (command === 'open-task') { openTaskDetail(id); return; }
    if (command === 'open-run') { openRunDetail(id); return; }

    if (command === 'set-phase') {
      if (!project) { notify('Выберите проект.', 'error'); return; }
      var phase = button.dataset.phase;
      if (!PHASES.some(function (entry) { return entry.id === phase; })) { notify('Фаза не распознана.', 'error'); return; }
      sendAction({ action: 'project.phase', phase: phase }, button, 'Фаза зафиксирована.');
      return;
    }

    if (command === 'idea-decide') {
      if (!project || !id) { notify('Идея не выбрана.', 'error'); return; }
      var idea = project.ideas.find(function (entry) { return idOf(entry) === id; });
      if (idea && decisionOf(project, idea)) { notify('Решение по идее уже зафиксировано.', 'error'); return; }
      sendAction({ action: 'idea.decide', id: id, decision: button.dataset.decision }, button, 'Решение по идее сохранено.');
      return;
    }

    if (command === 'lab-decide') {
      if (!project || !id) { notify('Лаборатория не выбрана.', 'error'); return; }
      var lab = project.labs.find(function (entry) { return idOf(entry) === id; });
      if (!lab) { notify('Лаборатория не найдена.', 'error'); return; }
      var decision = button.dataset.decision;
      var currentDecision = decisionOf(project, lab);
      var phase = labPhase(project, lab);
      if (decision === 'approved' || decision === 'rejected') {
        if (phase !== 'proposed' || currentDecision) { notify('Одобрение доступно только на этапе предложения.', 'error'); return; }
      } else if (decision === 'accepted' || decision === 'changes_requested') {
        if (!labDecisionReady(lab)) { notify('Приёмка заблокирована: backend требует readySeen и ready-запуск.', 'error'); return; }
        if (currentDecision === 'accepted' || currentDecision === 'changes_requested' || currentDecision === 'rejected') {
          notify('Итоговое решение уже зафиксировано.', 'error');
          return;
        }
      } else {
        notify('Решение не распознано.', 'error');
        return;
      }
      sendAction({ action: 'lab.decide', id: id, decision: decision }, button, 'Решение по лаборатории сохранено.');
      return;
    }

    if (command === 'lab-start' || command === 'lab-stop') {
      if (!project || !id) { notify('Лаборатория не выбрана.', 'error'); return; }
      var target = project.labs.find(function (entry) { return idOf(entry) === id; });
      if (!target) { notify('Лаборатория не найдена.', 'error'); return; }
      var action;
      if (command === 'lab-start') {
        if (!labStartAllowed(target)) { notify('Запуск заблокирован: состояние или конфигурация демо не позволяют запуск.', 'error'); return; }
        action = 'lab.start';
      } else {
        if (!labProcessRunning(target)) { notify('Демо не запущено — останавливать нечего.', 'error'); return; }
        action = 'lab.stop';
      }
      sendAction({ action: action, id: id }, button, command === 'lab-start' ? 'Демо запущено.' : 'Демо остановлено.');
    }
  }

  function bindEvents() {
    refs.projectSelect.addEventListener('change', function (event) {
      view.selectedId = event.target.value;
      resetSignatures();
      renderAll();
    });
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('click', handleClick);
    refs.detailDialog.addEventListener('click', function (event) {
      if (event.target === refs.detailDialog) refs.detailDialog.close();
    });
    var tablist = document.querySelector('[role="tablist"]');
    if (tablist) {
      tablist.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        var tabs = Array.prototype.slice.call(tablist.querySelectorAll('[role="tab"]'));
        var current = tabs.findIndex(function (tab) { return tab.dataset.tab === activeTab; });
        var step = event.key === 'ArrowRight' ? 1 : -1;
        var next = tabs[(current + step + tabs.length) % tabs.length];
        if (next) { event.preventDefault(); setTab(next.dataset.tab); next.focus(); }
      });
    }
  }

  function init() {
    cacheRefs();
    bindEvents();
    setTab('git');
    renderAll();
    pollLoop();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
