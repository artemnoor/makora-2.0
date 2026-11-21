'use strict';

const { createHash } = require('node:crypto');

const ZIP_LIMIT = 10 * 1024 * 1024;
const OPERATIONS = /^(get|put|post|delete|options|head|patch|trace)$/;
const FORBIDDEN_SEGMENT = /^(?:\.{1,2}|\.git|\.env(?:\..*)?|\.makora-outsource|(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(?:\..*)?)$/i;

class OutsourceError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.code = 'outsource.' + code;
    this.status = status;
  }
}

function fail(message, code, status) {
  throw new OutsourceError(message, code, status);
}

function field(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(`${label}: укажите от 1 до ${max} символов.`, 'invalid_fields');
  }
  return value.trim();
}

function archivePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.split('/').some((part) =>
    !part || part.length > 180 || /[<>:"\\|?*\x00-\x1f]/.test(part) ||
    /[ .]$/.test(part) || FORBIDDEN_SEGMENT.test(part))) {
    fail('Путь должен быть относительным и содержать допустимые имена файлов.', 'invalid_path');
  }
  return value;
}

function pathKey(value) {
  return value.normalize('NFC').toLowerCase();
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readOpenapi(value) {
  if (!object(value) || typeof value.openapi !== 'string' || !/^3\.[01]\.\d+$/.test(value.openapi) ||
      !object(value.info) || !object(value.paths)) {
    fail('Проверьте формат OpenAPI 3.0 или 3.1.', 'invalid_contract');
  }
  field(value.info.title, 'Название OpenAPI', 180);
  field(value.info.version, 'Версия OpenAPI', 100);
  if (value.info.version !== value.info.version.trim()) {
    fail('Уберите пробелы по краям версии контракта.', 'invalid_contract');
  }
  let hasOperation = false;
  for (const [route, item] of Object.entries(value.paths)) {
    if (!route.startsWith('/') || route.startsWith('//') || !object(item)) {
      fail('Проверьте пути операций OpenAPI.', 'invalid_contract');
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!OPERATIONS.test(method)) continue;
      if (!object(operation) || !object(operation.responses) || !Object.keys(operation.responses).length) {
        fail(`Укажите ответы для ${method.toUpperCase()} ${route}.`, 'invalid_contract');
      }
      hasOperation = true;
    }
  }
  if (!hasOperation) fail('Опишите хотя бы одну операцию API.', 'invalid_contract');
  const pending = [value];
  while (pending.length) {
    const node = pending.pop();
    for (const [key, child] of Object.entries(node)) {
      if (['$ref', '$dynamicRef', '$recursiveRef'].includes(key) &&
          (typeof child !== 'string' || !child.startsWith('#'))) {
        fail('Используйте ссылки внутри одного файла OpenAPI.', 'external_ref');
      }
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  return value;
}

function specification(payload) {
  if (!Array.isArray(payload.criteria) || !payload.criteria.length || payload.criteria.length > 30) {
    fail('Укажите от 1 до 30 критериев приёмки.', 'invalid_fields');
  }
  return {
    title: field(payload.title, 'Название', 180),
    goal: field(payload.goal, 'Результат', 3000),
    context: field(payload.context, 'Контекст', 5000),
    boundaries: field(payload.boundaries, 'Границы', 5000),
    targetPath: archivePath(field(payload.targetPath, 'Каталог модуля', 512)),
    criteria: payload.criteria.map((item) => field(item, 'Критерий приёмки', 2000)),
    openapi: readOpenapi(payload.openapi),
  };
}

function brief(id, spec) {
  const { targetPath, ...delivery } = spec;
  return {
    schemaVersion: 1,
    outsourceId: id,
    ...delivery,
    returnZip: {
      'outsource.json': { schemaVersion: 1, outsourceId: id, contractVersion: spec.openapi.info.version },
      'openapi.json': 'Копия поля openapi из задания.',
      'module/': 'Исходники, тесты и README с командами запуска и проверки.',
    },
  };
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

module.exports = { OutsourceError, ZIP_LIMIT, fail, field, archivePath, pathKey, specification, brief, sha256 };
