// Lazy access to Node's built-in SQLite (node:sqlite, Node >= 22.13) without
// printing its ExperimentalWarning to CLI users.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let mod;

function sqlite() {
  if (mod) return mod;
  const emit = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning))) return;
    return emit.call(process, warning, ...rest);
  };
  try { mod = require('node:sqlite'); }
  catch { throw new Error('读取 Cursor 会话需要 Node.js >= 22.13（内置 node:sqlite）'); }
  finally { process.emitWarning = emit; }
  return mod;
}

export function openDb(file, { readOnly = true } = {}) {
  const db = new (sqlite().DatabaseSync)(file, { readOnly });
  if (!readOnly) db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export const blobText = (v) => (v == null ? null : typeof v === 'string' ? v : Buffer.from(v).toString('utf8'));
