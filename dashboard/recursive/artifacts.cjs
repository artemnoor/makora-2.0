'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertSafeRelativePath, isRuntimeExcluded } = require('../../verified-workspaces.cjs');
const { fingerprint, hashBytes, requirePlan, SHA } = require('./plan.cjs');

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function realDirectory(value) {
  requirePlan(typeof value === 'string' && path.isAbsolute(value), 'artifact.directory', 'Нужен абсолютный каталог.');
  const full = path.resolve(value);
  let current = full;
  for (;;) {
    const stat = fs.lstatSync(current);
    requirePlan(stat.isDirectory() && !stat.isSymbolicLink(), 'artifact.unsafe_path', 'Каталог содержит ссылку: ' + current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return fs.realpathSync.native(full);
}

function regular(root, relative, optional = false) {
  const safe = assertSafeRelativePath(relative);
  const parts = safe.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat && optional) return null;
    requirePlan(stat && !stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()),
      'artifact.unsafe_path', 'Ожидался обычный файл: ' + relative);
  }
  return current;
}

function orderMap(values) {
  return Object.fromEntries(Object.entries(values).sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function walkFiles(root, omit = []) {
  const files = [];
  const pending = [''];
  while (pending.length) {
    const prefix = pending.pop();
    for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? prefix + '/' + entry.name : entry.name;
      if (isRuntimeExcluded(relative) || entry.isSymbolicLink()) {
        omit.push(relative);
      } else if (entry.isDirectory()) {
        pending.push(relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
  return files;
}

function inventory(root) {
  const omitted = [];
  const entries = walkFiles(root, omitted);
  requirePlan(!omitted.some((relative) => !isRuntimeExcluded(relative)), 'artifact.unsafe_path', 'В сборке обнаружена ссылка.');
  return orderMap(Object.fromEntries(entries.map((relative) => [relative, hashBytes(fs.readFileSync(regular(root, relative)))])));
}

function git(cwd, args) {
  return spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}

function splitNul(text) {
  return text.split('\0').filter(Boolean);
}

function statusPaths(raw) {
  const items = splitNul(raw);
  const entries = [];
  for (let i = 0; i < items.length; i++) {
    const code = items[i].slice(0, 2);
    const relative = items[i].slice(3);
    const from = /[RC]/.test(code) ? items[++i] : null;
    entries.push({ code, path: relative, from });
  }
  return entries;
}

function sourceManifest(source) {
  const gitFiles = git(source, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const gitMissing = gitFiles.error?.code === 'ENOENT' || /not a git repository/i.test(gitFiles.stderr || '');
  requirePlan(gitFiles.status === 0 || gitMissing, 'artifact.git', 'Не удалось получить список файлов проекта.');
  const omitted = [];
  const files = gitMissing ? walkFiles(source, omitted) : splitNul(gitFiles.stdout);
  const status = gitMissing ? null : git(source, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  requirePlan(!status || status.status === 0, 'artifact.git', 'Не удалось проверить рабочее дерево.');
  const gitStatus = status ? statusPaths(status.stdout) : [];
  const head = gitMissing ? null : git(source, ['rev-parse', '--verify', 'HEAD']);
  requirePlan(!head?.error, 'artifact.git', 'Не удалось проверить исходный HEAD.');
  const baseSha = head?.status === 0 ? head.stdout.trim() : null;
  const values = [];
  for (const relative of new Set(files)) {
    if (isRuntimeExcluded(relative)) {
      omitted.push(relative);
      continue;
    }
    const file = regular(source, relative, true);
    if (file) values.push([relative, hashBytes(fs.readFileSync(file))]);
  }
  const hashes = orderMap(Object.fromEntries(values));
  const edits = Object.fromEntries(gitStatus.flatMap((entry) => [entry.path, entry.from].filter(Boolean))
    .map((relative) => [relative, hashes[relative] ?? null]));
  return { hashes, baseSha, gitStatus, edits, omitted: [...new Set(omitted)].sort() };
}

function newDirectory(directory, root) {
  const canonicalRoot = realDirectory(root);
  const parent = realDirectory(path.dirname(directory));
  const result = path.join(parent, path.basename(directory));
  requirePlan(samePath(parent, canonicalRoot) || inside(canonicalRoot, result), 'artifact.unsafe_path', 'Сборка вне хранилища.');
  fs.mkdirSync(result, { mode: 0o700 });
  return result;
}

function copyVerified(source, directory, hashes) {
  for (const [relative, expected] of Object.entries(hashes)) {
    const bytes = fs.readFileSync(regular(source, relative));
    requirePlan(hashBytes(bytes) === expected, 'artifact.drift', 'Изменились байты ' + relative);
    const target = path.join(directory, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
}

function captureSnapshot(projectPath, directory, root, requiredHashes = {}) {
  const source = realDirectory(projectPath);
  requirePlan(!inside(source, path.resolve(directory)) && !samePath(source, directory),
    'artifact.unsafe_path', 'Снимок должен находиться вне проекта.');
  const manifest = sourceManifest(source);
  for (const [relative, expected] of Object.entries(requiredHashes)) {
    requirePlan(SHA.test(expected) && manifest.hashes[relative] === expected, 'artifact.baseline_hash', 'Не подтверждён файл ' + relative);
  }
  const output = newDirectory(directory, root);
  copyVerified(source, output, manifest.hashes);
  requirePlan(fingerprint(sourceManifest(source)) === fingerprint(manifest) &&
    fingerprint(inventory(output)) === fingerprint(manifest.hashes), 'artifact.drift', 'Проект изменился при создании снимка.');
  return { ...manifest, source, directory: output, manifestHash: fingerprint(manifest), usedArtifacts: [] };
}

function changesBetween(before, after) {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths.flatMap((relative) => {
    const beforeHash = before[relative] ?? null;
    const afterHash = after[relative] ?? null;
    return beforeHash === afterHash ? [] : [{ path: relative, beforeHash, afterHash }];
  });
}

function verifyInventory(directory, expected) {
  requirePlan(fingerprint(inventory(realDirectory(directory))) === fingerprint(orderMap(expected)), 'artifact.drift', 'Сборка изменилась.');
}

function canonicalLocation(root, directory) {
  const location = realDirectory(directory);
  requirePlan(inside(root, location), 'artifact.unsafe_path', 'Артефакт вне хранилища.');
  return location;
}

function treeHash(base, ids, hashes) {
  return ids.length === 0 ? base.manifestHash : fingerprint({ base: base.manifestHash, ids: [...ids].sort(), hashes: orderMap(hashes) });
}

function sealArtifact({ directory, input, dependencyArtifacts, changes, verificationHash, nodeId }) {
  const meta = { inputManifestHash: input.manifestHash, dependencyArtifacts: [...dependencyArtifacts].sort(),
    changes, verificationHash, nodeId };
  return { ...meta, id: fingerprint(meta), directory };
}

function orderedArtifacts(byId, ids) {
  const done = new Set();
  const order = [];
  const open = new Set();
  const frames = [...ids].reverse().map((id) => [id, false]);
  while (frames.length) {
    const [id, exit] = frames.pop();
    if (exit) {
      open.delete(id);
      if (!done.has(id)) { done.add(id); order.push(byId.get(id)); }
      continue;
    }
    if (done.has(id)) continue;
    const artifact = byId.get(id);
    requirePlan(artifact && !open.has(id) && Array.isArray(artifact.dependencyArtifacts),
      'artifact.dependency', 'Артефакт отсутствует или зависимости образуют цикл.');
    open.add(id);
    frames.push([id, true]);
    for (const dep of [...artifact.dependencyArtifacts].reverse()) frames.push([dep, false]);
  }
  return order;
}

function overlay(base, ordered) {
  const values = new Map(Object.entries(base.hashes));
  const sources = new Map();
  const pathKeys = new Map(Object.keys(base.hashes).map((relative) => [relative.toLowerCase(), relative]));
  for (const artifact of ordered) {
    for (const delta of artifact.changes) {
      const relative = assertSafeRelativePath(delta.path);
      const key = relative.toLowerCase();
      requirePlan(!pathKeys.has(key) || pathKeys.get(key) === relative, 'artifact.conflict', 'Конфликт регистра пути ' + relative);
      requirePlan((values.get(relative) ?? null) === delta.beforeHash &&
        (delta.afterHash === null || SHA.test(delta.afterHash)), 'artifact.conflict', 'Несовместимые изменения файла ' + relative);
      if (delta.afterHash === null) {
        values.delete(relative);
        sources.delete(relative);
        pathKeys.delete(key);
      } else {
        values.set(relative, delta.afterHash);
        sources.set(relative, artifact.directory);
        pathKeys.set(key, relative);
      }
    }
  }
  for (const relative of values.keys()) {
    let ancestor = relative;
    while (ancestor.includes('/')) {
      ancestor = ancestor.slice(0, ancestor.lastIndexOf('/'));
      requirePlan(!pathKeys.has(ancestor.toLowerCase()), 'artifact.conflict', 'Файл конфликтует с каталогом ' + ancestor);
    }
  }
  return { hashes: orderMap(Object.fromEntries(values)), sources };
}

function composeArtifacts(base, artifacts, selectedIds, output, storageRoot) {
  const root = realDirectory(storageRoot);
  const source = canonicalLocation(root, base.directory);
  verifyInventory(source, base.hashes);
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const order = orderedArtifacts(byId, selectedIds);
  for (const artifact of order) {
    const { id, directory, ...meta } = artifact;
    requirePlan(id === fingerprint(meta) && SHA.test(meta.verificationHash), 'artifact.hash', 'Отпечаток артефакта изменился.');
    canonicalLocation(root, directory);
    const inputs = orderedArtifacts(byId, artifact.dependencyArtifacts);
    requirePlan(artifact.inputManifestHash === treeHash(base, inputs.map((entry) => entry.id), overlay(base, inputs).hashes),
      'artifact.inputs_changed', 'Изменились входы артефакта.');
  }
  const combined = overlay(base, order);
  const directory = newDirectory(output, root);
  for (const [relative, expected] of Object.entries(combined.hashes)) {
    copyVerified(combined.sources.get(relative) ?? source, directory, { [relative]: expected });
  }
  verifyInventory(directory, combined.hashes);
  const usedArtifacts = order.map((item) => item.id);
  return { directory, hashes: combined.hashes, usedArtifacts, manifestHash: treeHash(base, usedArtifacts, combined.hashes) };
}

function invalidatedConsumers(artifacts, ids) {
  const invalid = new Set(ids);
  const downstream = new Map();
  for (const item of artifacts) {
    for (const dep of item.dependencyArtifacts) {
      if (!downstream.has(dep)) downstream.set(dep, []);
      downstream.get(dep).push(item.id);
    }
  }
  const queue = [...invalid];
  for (let i = 0; i < queue.length; i++) {
    for (const next of downstream.get(queue[i]) ?? []) {
      if (!invalid.has(next)) { invalid.add(next); queue.push(next); }
    }
  }
  return invalid;
}

module.exports = { samePath, inside, realDirectory, regular, inventory, sourceManifest, newDirectory, copyVerified,
  captureSnapshot, changesBetween, verifyInventory, sealArtifact, composeArtifacts, invalidatedConsumers, treeHash };
