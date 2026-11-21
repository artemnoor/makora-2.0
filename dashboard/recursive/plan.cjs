'use strict';

const crypto = require('node:crypto');
const { normalizeWriteScopes } = require('../../scope-gate.cjs');

const LIMITS = Object.freeze({
  parallel: 2, nodes: 24, attempts: 24, attemptsPerLeaf: 2,
  attemptMs: 1800000, activeMs: 7200000, reviews: 8, reviewMs: 600000,
  replans: 4, replanMs: 300000, checks: 36, integrations: 24,
  tokens: 0, costMicros: 0,
});

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const SHA = /^[a-f0-9]{64}$/;

class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function requirePlan(condition, code, message) {
  if (!condition) throw new PlanError(code, message);
}

function fingerprint(value) {
  return hashBytes(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
}

function hashBytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function id(value, field) {
  requirePlan(typeof value === 'string' && ID.test(value), 'plan.invalid_id', 'Недопустимый идентификатор ' + field);
  return value;
}

function string(value, field, maximum, optional = false) {
  if (optional && value == null) return '';
  requirePlan(typeof value === 'string' && value.length <= maximum && !value.includes('\0') &&
    (optional || value.trim()), 'plan.invalid_field', 'Проверьте поле ' + field);
  return value.trim();
}

function list(value, field, normalize, maximum = 64) {
  requirePlan(Array.isArray(value) && value.length <= maximum, 'plan.invalid_field', 'Проверьте список ' + field);
  return value.map((item) => normalize(item, field));
}

function normalizeLimits(raw = {}) {
  requirePlan(raw && typeof raw === 'object' && !Array.isArray(raw), 'plan.invalid_limits', 'Проверьте лимиты.');
  for (const key of Object.keys(raw)) {
    requirePlan(Object.hasOwn(LIMITS, key), 'plan.invalid_limits', 'Неподдерживаемый лимит ' + key);
  }
  return Object.fromEntries(Object.entries(LIMITS).map(([key, fallback]) => {
    const value = raw[key] ?? fallback;
    const metered = key === 'tokens' || key === 'costMicros';
    const max = metered ? Number.MAX_SAFE_INTEGER : key === 'parallel' ? 3 : key.endsWith('Ms') ? 86400000 : 512;
    requirePlan(Number.isInteger(value) && value >= (metered ? 0 : 1) && value <= max, 'plan.invalid_limits', 'Недопустимый лимит ' + key);
    return [key, value];
  }));
}

function check(raw) {
  requirePlan(raw && ['node', 'python'].includes(raw.executable), 'plan.invalid_check',
    'Проверка должна использовать разрешённый runtime node или python.');
  const args = list(raw.args ?? [], 'args', (arg) => {
    requirePlan(typeof arg === 'string' && arg.length <= 4096 && !arg.includes('\0'), 'plan.invalid_check', 'Недопустимый аргумент проверки.');
    return arg;
  });
  return { executable: raw.executable, args };
}

function normalizeNode(raw) {
  requirePlan(raw && ['branch', 'leaf'].includes(raw.kind), 'plan.invalid_kind', 'Узел должен быть ветвью или листом.');
  const leaf = raw.kind === 'leaf';
  const node = {
    id: id(raw.id, 'узла'), parentId: raw.parentId == null ? null : id(raw.parentId, 'родителя'),
    kind: raw.kind, title: string(raw.title, 'название узла', 240),
    goal: string(raw.goal, 'цель', 4000, !leaf),
    context: string(raw.context, 'контекст', 6000, true),
    contract: string(raw.contract, 'контракт', 4000, !leaf),
    criteria: list(raw.criteria, 'критерии', (item) => string(item, 'критерий', 1000)),
    checks: list(raw.checks, 'проверки', check, 20),
    dependsOn: [...new Set(list(raw.dependsOn ?? [], 'зависимости', id))],
  };
  requirePlan(node.criteria.length && node.checks.length, 'plan.incomplete_node', 'Укажите критерии и проверки для ' + node.id);
  if (leaf) {
    requirePlan(Array.isArray(raw.writeScope) && raw.writeScope.length, 'plan.invalid_scope', 'Укажите зону записи для ' + node.id);
    try {
      node.writeScope = normalizeWriteScopes(raw.writeScope, 'writeScope').map((scope) => scope.value);
    } catch (error) {
      throw new PlanError('plan.invalid_scope', error.message);
    }
    node.model = string(raw.model, 'модель', 120);
    node.profile = string(raw.profile, 'профиль', 120);
    requirePlan(/^opencode\/[a-z0-9._-]+$/i.test(node.model) && node.profile === node.model,
      'plan.invalid_model', 'Задайте точный ID согласованной модели OpenCode и её профиля.');
  } else {
    requirePlan(!raw.model && !raw.profile && !raw.writeScope?.length, 'plan.branch_execution', 'Исполнитель назначается листу.');
  }
  return node;
}

function validateGraph(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  requirePlan(byId.size === nodes.length, 'plan.duplicate_node', 'Идентификатор узла повторяется.');
  const roots = nodes.filter((node) => node.parentId === null);
  requirePlan(roots.length === 1, 'plan.root', 'У дерева должен быть один корень.');
  const edges = new Map();
  const degree = new Map();
  const childCount = new Map(nodes.map((node) => [node.id, 0]));
  for (const node of nodes) {
    for (const key of ['start:' + node.id, 'end:' + node.id]) {
      edges.set(key, []);
      degree.set(key, 0);
    }
  }
  const link = (from, to) => {
    edges.get(from).push(to);
    degree.set(to, degree.get(to) + 1);
  };
  for (const node of nodes) {
    link('start:' + node.id, 'end:' + node.id);
    if (node.parentId !== null) {
      requirePlan(byId.get(node.parentId)?.kind === 'branch', 'plan.parent', 'Недопустимый родитель узла ' + node.id);
      link('start:' + node.parentId, 'start:' + node.id);
      link('end:' + node.id, 'end:' + node.parentId);
      childCount.set(node.parentId, childCount.get(node.parentId) + 1);
    }
    for (const dep of node.dependsOn) {
      requirePlan(byId.has(dep), 'plan.dependency', 'Не найдена зависимость ' + dep);
      link('end:' + dep, 'start:' + node.id);
    }
  }
  for (const node of nodes) {
    requirePlan(node.kind === 'leaf' || childCount.get(node.id) > 0, 'plan.empty_branch', 'Ветвь пуста ' + node.id);
  }
  const queue = [...degree].filter(([, count]) => count === 0).map(([key]) => key);
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i])) {
      const count = degree.get(next) - 1;
      degree.set(next, count);
      if (count === 0) queue.push(next);
    }
  }
  requirePlan(queue.length === edges.size, 'plan.cycle', 'Дерево и зависимости образуют цикл.');
  return roots[0].id;
}

function normalizePlan(raw) {
  const limits = normalizeLimits(raw.limits);
  const nodes = list(raw.nodes, 'узлы', normalizeNode, limits.nodes);
  const plan = {
    id: id(raw.id, 'плана'), title: string(raw.title, 'название', 240),
    requirements: string(raw.requirements, 'требования', 12000), rootId: validateGraph(nodes), limits, nodes,
  };
  return { ...plan, fingerprint: fingerprint(plan) };
}

function draftPlan(raw) {
  requirePlan(raw.integration && typeof raw.integration === 'object', 'plan.incomplete_node', 'Укажите общую интеграционную проверку.');
  const groups = raw.groups ?? {};
  requirePlan(groups && typeof groups === 'object' && !Array.isArray(groups), 'plan.invalid_field', 'Проверьте группы работ.');
  const root = { ...raw.integration, id: 'root', title: raw.title, kind: 'branch', parentId: null };
  const branches = new Map();
  const work = list(raw.work, 'работы', (item) => {
    requirePlan(item && typeof item === 'object', 'plan.invalid_field', 'Проверьте описание работы.');
    const group = item.group;
    if (group == null) return { ...item, parentId: root.id, kind: 'leaf' };
    id(group, 'группы работ');
    requirePlan(Object.hasOwn(groups, group), 'plan.incomplete_node', 'У группы нет интеграционной проверки ' + group);
    if (!branches.has(group)) {
      branches.set(group, { ...groups[group], id: 'group-' + group, kind: 'branch', parentId: root.id });
    }
    return { ...item, parentId: branches.get(group).id, kind: 'leaf' };
  }, LIMITS.nodes * 20);
  return { ...raw, nodes: [root, ...branches.values(), ...work] };
}

function changedScope(previous, next) {
  if (previous.requirements !== next.requirements || fingerprint(previous.limits) !== fingerprint(next.limits)) return true;
  const approvedChecks = new Set(previous.nodes.flatMap((node) => node.checks.map(fingerprint)));
  const scopes = previous.nodes.filter((node) => node.kind === 'leaf').flatMap((node) =>
    node.writeScope.map((value) => ({ value: value.toLowerCase(), model: node.model, profile: node.profile })));
  return next.nodes.some((node) => node.checks.some((item) => !approvedChecks.has(fingerprint(item))) ||
    (node.kind === 'leaf' && node.writeScope.some((value) => !scopes.some((old) =>
      node.model === old.model && node.profile === old.profile &&
      (value.toLowerCase() === old.value || (old.value.endsWith('/') && value.toLowerCase().startsWith(old.value)))))));
}

module.exports = { LIMITS, SHA, PlanError, requirePlan, fingerprint, hashBytes, id, normalizePlan, draftPlan, changedScope };
