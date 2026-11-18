'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { crc32 } = require('node:zlib');
const { isDeepStrictEqual } = require('node:util');
const { randomUUID } = require('node:crypto');
const { archivePath, pathKey, sha256, fail, OutsourceError } = require('./outsource.cjs');

const MAX_ENTRIES = 512;
const MAX_EXPANDED = 32 * 1024 * 1024;
const OWNER_FILE = '.makora-outsource';

function json(data, filename) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, ''));
  } catch {
    fail(`Файл ${filename} должен содержать корректный UTF-8 JSON.`, 'invalid_archive');
  }
}

function register(entries, key, name, isDirectory) {
  const existing = entries.get(key);
  if (existing && (existing.name !== name || !existing.directory || !isDirectory)) {
    fail(`Конфликт путей ZIP: ${name}.`, 'path_conflict');
  }
  if (!existing) entries.set(key, { name, directory: isDirectory });
}

async function readArchive(buffer, brief) {
  let yauzl;
  try {
    yauzl = require('yauzl');
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    fail('Установите ZIP-зависимость в каталоге Makora: npm ci --ignore-scripts.', 'dependency', 503);
  }
  const files = new Map();
  const entries = new Map();
  const explicit = new Set();
  let expanded = 0;
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, strictFileNames: true });
    if (zip.entryCount > MAX_ENTRIES) fail('Слишком много записей в ZIP.', 'archive_limit');
    for await (const entry of zip.eachEntry()) {
      const directory = entry.fileName.endsWith('/');
      const name = archivePath(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
      const dosDirectory = Boolean(entry.externalFileAttributes & 0x10);
      const reparse = Boolean(entry.externalFileAttributes & 0x400);
      if (reparse || (mode && mode !== (directory ? 0o040000 : 0o100000)) || (dosDirectory && !directory)) {
        fail(`Недопустимый тип записи ZIP: ${name}.`, 'invalid_archive');
      }
      if (directory ? name !== 'module' && !name.startsWith('module/') :
          name !== 'outsource.json' && name !== 'openapi.json' && !name.startsWith('module/')) {
        fail(`Неожиданный путь ZIP: ${name}.`, 'invalid_archive');
      }
      const key = pathKey(name);
      if (explicit.has(key)) fail(`Повторяющийся путь ZIP: ${name}.`, 'path_conflict');
      explicit.add(key);
      let prefix = '';
      for (const part of name.split('/').slice(0, -1)) {
        prefix = prefix ? prefix + '/' + part : part;
        register(entries, pathKey(prefix), prefix, true);
      }
      register(entries, key, name, directory);
      if (directory) {
        if (entry.uncompressedSize) fail('Запись каталога ZIP содержит данные.', 'invalid_archive');
        continue;
      }
      expanded += entry.uncompressedSize;
      if (expanded > MAX_EXPANDED) fail('Распакованный ZIP превышает 32 МиБ.', 'archive_limit');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      if (crc32(bytes) !== entry.crc32) fail(`Ошибка контрольной суммы ZIP: ${name}.`, 'invalid_archive');
      files.set(name, bytes);
    }
  } catch (error) {
    if (error instanceof OutsourceError) throw error;
    fail('Не удалось прочитать ZIP. Проверьте формат и целостность архива.', 'invalid_archive');
  } finally {
    zip?.close();
  }

  if (!files.has('outsource.json') || !files.has('openapi.json') ||
      ![...files.keys()].some((name) => name.startsWith('module/'))) {
    fail('В ZIP нужны outsource.json, openapi.json и файлы в module/.', 'invalid_archive');
  }
  if (!isDeepStrictEqual(json(files.get('outsource.json'), 'outsource.json'), brief.returnZip['outsource.json'])) {
    fail('ZIP относится к другому заданию или версии контракта.', 'manifest_mismatch', 409);
  }
  if (!isDeepStrictEqual(json(files.get('openapi.json'), 'openapi.json'), brief.openapi)) {
    fail('OpenAPI в ZIP отличается от контракта в ТЗ.', 'contract_mismatch', 409);
  }
  return files;
}

function stat(target) {
  return fs.lstatSync(target, { throwIfNoEntry: false });
}

function checkedDirectory(directory) {
  const info = stat(directory);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    fail('Для операции нужен существующий каталог без символических ссылок.', 'unsafe_directory', 409);
  }
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

function checkRealDirectory(directory) {
  checkedDirectory(directory);
  if (path.relative(fs.realpathSync(directory), directory) !== '') {
    fail('Путь к каталогу проходит через символическую ссылку.', 'unsafe_directory', 409);
  }
}

function writeFile(root, name, bytes) {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
  } catch (error) {
    fs.closeSync(fd);
    fs.unlinkSync(target);
    throw error;
  }
  fs.closeSync(fd);
  return target;
}

function artifactRoot(dataDir) {
  const root = path.join(fs.realpathSync.native(dataDir), 'outsource');
  if (!stat(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  checkRealDirectory(root);
  return root;
}

function stage(dataDir, files, digest) {
  const root = artifactRoot(dataDir);
  const folder = randomUUID();
  const location = path.join(root, folder);
  fs.mkdirSync(location, { mode: 0o700 });
  try {
    const manifest = [];
    for (const [name, bytes] of files) {
      writeFile(location, name, bytes);
      manifest.push({ path: name, size: bytes.length, sha256: sha256(bytes) });
    }
    manifest.sort((left, right) => left.path.localeCompare(right.path));
    return { folder, location, sha256: digest, files: manifest };
  } catch (error) {
    fs.rmSync(location, { recursive: true, force: true });
    throw error;
  }
}

function discard(artifact) {
  if (artifact) fs.rmSync(artifact.location, { recursive: true, force: true });
}

function checkArtifact(dataDir, artifact) {
  const root = path.join(artifactRoot(dataDir), artifact.folder);
  checkRealDirectory(root);
  const files = new Map();
  for (const entry of artifact.files) {
    const filename = path.join(root, entry.path);
    checkRealDirectory(path.dirname(filename));
    const info = stat(filename);
    if (!info?.isFile() || info.size !== entry.size) {
      fail('Файлы в хранилище изменились. Загрузите проверенный ZIP заново.', 'artifact_changed', 409);
    }
    const bytes = fs.readFileSync(filename);
    if (sha256(bytes) !== entry.sha256) {
      fail('Файлы в хранилище изменились. Загрузите проверенный ZIP заново.', 'artifact_changed', 409);
    }
    files.set(entry.path, bytes);
  }
  return files;
}

function projectTarget(projectPath, targetPath, dataDir) {
  checkRealDirectory(projectPath);
  const target = path.join(fs.realpathSync.native(projectPath), targetPath);
  const parent = path.dirname(target);
  checkRealDirectory(parent);
  const realData = fs.realpathSync.native(dataDir);
  if (inside(realData, target) || inside(target, realData)) {
    fail('Каталог модуля пересекается с хранилищем Makora.', 'unsafe_directory', 409);
  }
  return target;
}

function delivery(files) {
  const result = new Map([['openapi.json', files.get('openapi.json')]]);
  for (const [name, bytes] of files) {
    if (name.startsWith('module/')) result.set(name, bytes);
  }
  return result;
}

function owned(target, marker) {
  const file = path.join(target, OWNER_FILE);
  const info = stat(file);
  return info?.isFile() && info.size === Buffer.byteLength(marker) && fs.readFileSync(file, 'utf8') === marker;
}

// При повторе после сбоя проверяем файлы, уже записанные в выделенную папку,
// и дописываем отсутствующие. Чужой каталог не принимается за наш.
function resume(target, files) {
  const directories = new Set();
  for (const name of files.keys()) {
    const parts = name.split('/');
    while (parts.length > 1) {
      parts.pop();
      directories.add(parts.join('/'));
    }
  }
  const pending = [target];
  while (pending.length) {
    const directory = pending.pop();
    checkRealDirectory(directory);
    for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
      const location = path.join(directory, child.name);
      const relative = path.relative(target, location).split(path.sep).join('/');
      if (relative === OWNER_FILE) continue;
      const expected = files.get(relative);
      if (child.isDirectory() && directories.has(relative)) {
        pending.push(location);
      } else if (!child.isFile() || !expected || stat(location)?.size !== expected.length ||
          !expected.equals(fs.readFileSync(location))) {
        fail('В каталоге интеграции появились посторонние или изменённые файлы.', 'target_changed', 409);
      }
    }
  }
  for (const [name, bytes] of files) {
    if (!stat(path.join(target, name))) writeFile(target, name, bytes);
  }
}

function integrate({ projectPath, targetPath, dataDir, artifact, id }) {
  const files = delivery(checkArtifact(dataDir, artifact));
  const target = projectTarget(projectPath, targetPath, dataDir);
  const marker = id + '\n' + artifact.sha256 + '\n';
  if (stat(target)) {
    checkRealDirectory(target);
    if (!owned(target, marker)) fail('Каталог модуля уже существует. Файлы не были перезаписаны.', 'target_exists', 409);
    resume(target, files);
    return;
  }
  const sibling = fs.readdirSync(path.dirname(target)).some((name) => pathKey(name) === pathKey(path.basename(target)));
  if (sibling) fail('Каталог модуля уже существует с другим написанием.', 'target_exists', 409);
  fs.mkdirSync(target);
  const written = [];
  try {
    written.push(writeFile(target, OWNER_FILE, marker));
    for (const [name, bytes] of files) written.push(writeFile(target, name, bytes));
  } catch (error) {
    // Убираем только свои файлы и пустые каталоги. Если очистка прервётся,
    // маркер позволяет повторить интеграцию с тем же принятым архивом.
    for (const file of written.slice(1)) {
      try { fs.unlinkSync(file); } catch { /* повторы проверяют оставшиеся файлы */ }
    }
    const dirs = new Set();
    for (const name of files.keys()) {
      let parent = path.dirname(path.join(target, name));
      while (parent !== target) {
        dirs.add(parent);
        parent = path.dirname(parent);
      }
    }
    for (const directory of [...dirs].sort((left, right) => right.length - left.length)) {
      try { fs.rmdirSync(directory); } catch { /* каталог занят либо отсутствует */ }
    }
    try {
      if (written[0] && fs.readdirSync(target).length === 1 && owned(target, marker)) fs.unlinkSync(written[0]);
      fs.rmdirSync(target);
    } catch { /* оставить занятую папку для повторной проверки */ }
    throw error;
  }
}

function finishIntegration({ projectPath, targetPath, dataDir, artifact, id }) {
  const target = projectTarget(projectPath, targetPath, dataDir);
  if (!stat(target)) return;
  checkRealDirectory(target);
  if (owned(target, id + '\n' + artifact.sha256 + '\n')) fs.unlinkSync(path.join(target, OWNER_FILE));
}

module.exports = { readArchive, stage, discard, checkArtifact, integrate, finishIntegration };
