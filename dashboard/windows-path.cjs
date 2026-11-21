'use strict';

function ordinaryPath(filename) {
  if (process.platform !== 'win32') return filename;
  return filename
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\\\\\?\\(?=[a-z]:\\)/i, '');
}

module.exports = { ordinaryPath };
