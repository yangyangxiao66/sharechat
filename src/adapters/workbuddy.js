// WorkBuddy desktop: session metadata lives in ~/.workbuddy/workbuddy.db and
// the transcript is an append-only JSONL under projects/<project>/<id>.jsonl.
// WorkBuddy is a source only for now; writing its private transcript/index is
// intentionally not attempted.
import path from 'node:path';
import { HOME, exists, headJsonl, readJsonl, mtime, stripBlocks, toText, tryParse, walkFiles } from '../util.js';
import { openDb } from '../sqlite.js';
import { newSession, Builder } from '../session.js';

export const id = 'workbuddy';
export const label = 'WorkBuddy';

function defaultRoot() {
  if (process.env.WORKBUDDY_HOME) return path.resolve(process.env.WORKBUDDY_HOME);
  const primary = path.join(HOME, '.workbuddy');
  return exists(primary) ? primary : path.join(HOME, '.workbuddy-ai');
}

export function home() { return defaultRoot(); }

const iso = (value) => {
  if (value == null || value === '') return null;
  const date = typeof value === 'number' || /^\d+$/.test(String(value))
    ? new Date(Number(value))
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const NOISE_TAGS = [
  'system-reminder', 'user_info', 'identity_context', 'product_identity',
  'project_context', 'project_layout', 'connector-status', 'current_time',
  'memory_and_skills_reminder', 'craft_mode', 'user_references', 'attached_files',
  'cb_summary', 'conversation_history_summary', 'task-notification',
];

function partsText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [content])
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part?.text === 'string') return part.text;
      if (part?.type?.includes('image')) return '[图片]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function userText(message) {
  const raw = partsText(message.content);
  if (!raw.trim()) return '';
  const startsNew = message.providerData?.startsNewUserRequest === true;
  if (!startsNew && /<cb_summary\b|<conversation_history_summary\b|<task-notification\b/i.test(raw)) return '';
  const queries = [...raw.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (queries.length) return queries.join('\n');
  const rest = stripBlocks(raw, NOISE_TAGS);
  if (!rest) return '';
  if (/^<[a-z_-]+[\s>]/i.test(rest)) return '';
  return rest;
}

function assistantText(message) {
  const content = message.content;
  if (typeof content === 'string') return content.trim();
  return (Array.isArray(content) ? content : [content])
    .filter((part) => typeof part === 'string' || part?.type === 'output_text' || part?.type === 'text')
    .map((part) => (typeof part === 'string' ? part : part.text))
    .filter((text) => typeof text === 'string' && text.trim())
    .join('\n')
    .trim();
}

function transcriptFiles() {
  const root = path.join(home(), 'projects');
  const files = new Map();
  for (const file of walkFiles(root, (name) => name.endsWith('.jsonl') && !name.endsWith('.file-rollback.ndjson'), 3)) {
    const sessionId = path.basename(file, '.jsonl');
    if (sessionId) files.set(sessionId, file);
  }
  return files;
}

function dbRows() {
  const file = path.join(home(), 'workbuddy.db');
  if (!exists(file)) return [];
  let db;
  try {
    db = openDb(file);
    return db.prepare(`SELECT id, cwd, title, custom_title, model, created_at, updated_at, last_activity_at, status
      FROM sessions WHERE deleted_at IS NULL`).all();
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function fileMeta(file, sessionId) {
  const head = headJsonl(file, 256 * 1024);
  const first = head.find((record) => record.cwd);
  const user = head.find((record) => record.type === 'message' && record.role === 'user');
  const title = user ? userText(user).replace(/\s+/g, ' ').slice(0, 80) : '';
  return {
    agent: id,
    id: sessionId,
    file,
    cwd: first?.cwd || '',
    title,
    createdAt: iso(head.find((record) => record.timestamp)?.timestamp),
    updatedAt: mtime(file),
  };
}

export function list() {
  const files = transcriptFiles();
  const rows = dbRows();
  const out = [];
  const seen = new Set();

  for (const row of rows) {
    const file = files.get(String(row.id));
    if (!file) continue;
    seen.add(String(row.id));
    out.push({
      agent: id,
      id: String(row.id),
      file,
      cwd: row.cwd || '',
      title: row.custom_title || row.title || '',
      model: row.model || '',
      createdAt: iso(row.created_at),
      updatedAt: iso(row.last_activity_at || row.updated_at) || mtime(file),
      status: row.status || '',
    });
  }

  for (const [sessionId, file] of files) {
    if (!seen.has(sessionId)) out.push(fileMeta(file, sessionId));
  }

  return out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function load(meta) {
  const s = newSession(id, meta.id, {
    file: meta.file,
    cwd: meta.cwd,
    title: meta.title,
    model: meta.model,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  });
  const b = new Builder(s);
  const rows = readJsonl(meta.file);

  for (const record of rows) {
    const ts = iso(record.timestamp);
    if (record.type === 'message') {
      if (record.role === 'user') {
        const text = userText(record);
        if (text) b.user(text, ts);
        if (!s.cwd && record.cwd) s.cwd = record.cwd;
      } else if (record.role === 'assistant') {
        if (record.providerData?.model) s.model = record.providerData.model;
        const text = assistantText(record);
        if (text) b.text(text, ts);
      }
    } else if (record.type === 'function_call') {
      if (record.providerData?.model) s.model = record.providerData.model;
      b.tool(record.callId, record.name || 'tool', tryParse(record.arguments), ts);
    } else if (record.type === 'function_call_result') {
      const output = record.output?.text ?? record.output?.content ?? record.output;
      const status = String(record.status || '').toLowerCase();
      const isError = (status && !['completed', 'success', 'succeeded'].includes(status)) || record.output?.type === 'error';
      b.result(record.callId, toText(output), isError);
    } else if (record.type === 'ai-title' && record.aiTitle) {
      s.title = String(record.aiTitle);
    } else if (record.type === 'session-meta' && !s.cwd && record.cwd) {
      s.cwd = record.cwd;
    }
  }

  if (!s.cwd) {
    const first = rows.find((record) => record.cwd);
    if (first) s.cwd = first.cwd;
  }
  return b.done();
}
