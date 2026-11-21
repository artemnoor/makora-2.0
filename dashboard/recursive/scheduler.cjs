'use strict';

const { normalizeWriteScopes, validateScopeBoundaries } = require('../../scope-gate.cjs');
const { fingerprint } = require('./plan.cjs');
const { invalidatedConsumers } = require('./artifacts.cjs');

const AVAILABLE = new Set(['tests_passed', 'reviewing', 'codex_reviewed', 'accepted']);
const BUSY = new Set(['claimed', 'dispatched', 'unknown']);

function graph(plan) {
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  const children = new Map(plan.nodes.map((node) => [node.id, []]));
  for (const node of plan.nodes) if (node.parentId) children.get(node.parentId).push(node);
  return { byId, children };
}

function inputs(node, byId) {
  const dependencies = new Set();
  for (let current = node; current; current = byId.get(current.parentId)) {
    for (const dep of current.dependsOn) dependencies.add(dep);
  }
  return [...dependencies];
}

function canUse(node, prerequisite, state) {
  return Boolean(state?.artifactId && (state.state === 'accepted' ||
    (node.kind === 'leaf' && prerequisite.kind === 'leaf' && node.parentId === prerequisite.parentId &&
      AVAILABLE.has(state.state))));
}

function readyWork(plan, run) {
  const { byId, children } = graph(plan);
  const leaves = [];
  const branches = [];
  for (const node of plan.nodes) {
    const state = run.nodes[node.id];
    if (!state || !['approved', 'queued', 'planning', 'executing'].includes(state.state)) continue;
    const deps = inputs(node, byId);
    if (!deps.every((dep) => canUse(node, byId.get(dep), run.nodes[dep]))) continue;
    const childNodes = children.get(node.id);
    if (node.kind === 'branch' && !childNodes.every((child) => AVAILABLE.has(run.nodes[child.id]?.state))) continue;
    const ids = [...new Set([...deps, ...childNodes.map((child) => child.id)].map((dep) => run.nodes[dep].artifactId))].sort();
    if (node.kind === 'leaf') leaves.push({ node, ids });
    else branches.push({ node, ids });
  }
  return { leaves, branches };
}

function selectBatch(leaves, limit) {
  const first = leaves[0];
  if (!first || limit < 1) return [];
  const selected = [first];
  const firstKey = fingerprint(first.ids);
  for (const entry of leaves.slice(1)) {
    if (selected.length === limit) break;
    if (fingerprint(entry.ids) !== firstKey) continue;
    const candidates = [...selected, entry].map(({ node }) => ({ name: node.id, scopes: normalizeWriteScopes(node.writeScope) }));
    try {
      validateScopeBoundaries(candidates);
      selected.push(entry);
    } catch { /* scope overlaps are serialized */ }
  }
  return selected;
}

function reviewNeeded(plan, node) {
  if (node.id === plan.rootId) return true;
  return plan.nodes.some((consumer) => consumer.dependsOn.includes(node.id) &&
    (node.kind === 'branch' || consumer.kind !== 'leaf' || consumer.parentId !== node.parentId));
}

function invalidate(run, artifacts, ids) {
  const affected = invalidatedConsumers(artifacts, ids);
  for (const state of Object.values(run.nodes)) {
    if ((state.artifactId && affected.has(state.artifactId)) || state.inputs?.some((id) => affected.has(id))) {
      state.state = 'invalidated';
      state.reason = 'Изменился или отклонён входной артефакт.';
    }
  }
  return affected;
}

function reviewClosure(run, artifacts, id) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const stack = [id];
  const visited = new Set();
  const accept = [];
  while (stack.length) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const artifact = byId.get(current);
    if (!artifact) return null;
    const node = run.nodes[artifact.nodeId];
    if (!node || node.artifactId !== current || !AVAILABLE.has(node.state)) return null;
    accept.push(node);
    stack.push(...artifact.dependencyArtifacts);
  }
  return accept;
}

function elapsed(intervals) {
  let total = 0;
  let end = 0;
  for (const [start, stop] of [...intervals].sort((a, b) => a[0] - b[0])) {
    if (stop <= end || stop < start) continue;
    total += stop - Math.max(start, end);
    end = stop;
  }
  return total;
}

module.exports = { AVAILABLE, BUSY, readyWork, selectBatch, reviewNeeded, invalidate, reviewClosure, elapsed };
