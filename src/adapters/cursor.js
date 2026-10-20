// Cursor: Desktop composers (global state.vscdb), Cursor CLI chats (store.db)
// and agent transcripts. See src/cursor-store.js for the storage layout.
import path from 'node:path';
import { exists, listDir, readJsonl, mtime, stripBlocks, toText, readJson } from '../util.js';
import { openDb, blobText } from '../sqlite.js';
import { cursorHome, cursorUserDir, globalDbPath, workspaces, stateHashes } from '../cursor-store.js';
import { newSession, Builder } from '../session.js';

export const id = 'cursor';
export const label = 'Cursor';

export function home() { return cursorUserDir(); }

const iso = (ms) => (Number.isFinite(Number(ms)) && Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);
const parse = (v) => { try { return JSON.parse(blobText(v)); } catch { return null; } };
const NOISE = ['user_info', 'system_reminder', 'timestamp', 'environment_context', 'user_instructions', 'manually_attached_skills', 'attached_files', 'rules'];

// Cursor wraps the typed prompt in <user_query>; everything else is injected context.
function userText(content) {
  const raw = typeof content === 'string' ? content
    : (content || []).map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[图片]' : '')).join('\n');
  const q = [...raw.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)].map((m) => m[1]);
  if (q.length) return q.join('\n');
  const rest = stripBlocks(raw, NOISE);
  return /^<[a-z_]+[\s>]/i.test(rest) ? '' : rest;
}

// slug used by ~/.cursor/projects: "g:\xinxiai\lingxi-ai" -> "g-xinxiai-lingxi-ai"
const slugOf = (folder) => folder.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase()).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// ---------- listing ----------
function desktopList() {
  const file = globalDbPath();
  if (!exists(file)) return [];
  const db = openDb(file);
  try {
    const rows = db.prepare('SELECT composerId, workspaceId, createdAt, lastUpdatedAt, value FROM composerHeaders '
      + 'WHERE COALESCE(isArchived, 0) = 0 AND COALESCE(isSubagent, 0) = 0').all();
    // Skip never-used composers ("New chat" placeholders) with no messages.
    const size = db.prepare("SELECT json_array_length(value, '$.fullConversationHeadersOnly') n FROM cursorDiskKV WHERE key = ?");
    return rows.filter((r) => (size.get(`composerData:${r.composerId}`)?.n ?? 0) > 0).map((r) => {
      const head = parse(r.value) || {};
      const uri = head.workspaceIdentifier?.uri;
      return {
        agent: id, id: r.composerId, file, source: 'desktop',
        cwd: uri?.fsPath || uri?.path || '',
        title: head.name || head.subtitle || '',
        createdAt: iso(r.createdAt), updatedAt: iso(r.lastUpdatedAt),
      };
    });
  } finally { db.close(); }
}

function transcriptList() {
  const out = [];
  const projects = path.join(cursorHome(), 'projects');
  const bySlug = new Map(workspaces().map((w) => [slugOf(w.folder).toLowerCase(), w.folder]));
  for (const p of listDir(projects)) {
    if (!p.isDirectory()) continue;
    const dir = path.join(projects, p.name, 'agent-transcripts');
    for (const s of listDir(dir)) {
      const file = path.join(dir, s.name, `${s.name}.jsonl`);
      if (!s.isDirectory() || !exists(file)) continue;
      out.push({
        agent: id, id: s.name, file, source: 'transcript',
        cwd: bySlug.get(p.name.toLowerCase()) || '', title: '', updatedAt: mtime(file),
      });
    }
  }
  return out;
}

function cliList() {
  const out = [];
  const chats = path.join(cursorHome(), 'chats');
  for (const ws of listDir(chats)) {
    if (!ws.isDirectory()) continue;
    for (const s of listDir(path.join(chats, ws.name))) {
      const dir = path.join(chats, ws.name, s.name);
      const store = path.join(dir, 'store.db');
      if (!s.isDirectory() || !exists(store)) continue;
      const meta = readJson(path.join(dir, 'meta.json')) || {};
      out.push({
        agent: id, id: s.name, file: store, source: 'cli',
        cwd: meta.cwd || meta.workspacePath || '', title: meta.title || meta.name || '',
        updatedAt: iso(meta.updatedAtMs) || mtime(store),
      });
    }
  }
  return out;
}

export function list() {
  const seen = new Map();
  for (const s of [...desktopList(), ...cliList(), ...transcriptList()]) {
    if (!seen.has(s.id)) seen.set(s.id, s);
  }
  return [...seen.values()];
}

// ---------- loading ----------
const rawText = (content) => (typeof content === 'string' ? content : (content || []).map((p) => p.text ?? '').join('\n'));

// Runtime injections that Cursor sends as user messages: background-task
// notices carry a <system_notification> block (even though they also wrap a
// canned prompt in <user_query>); and once a conversation wraps typed prompts
// in <user_query>, any unwrapped user message is injected too.
function isInjected(raw, wrapped) {
  return raw.includes('<system_notification>') || (wrapped && !raw.includes('<user_query>'));
}

// AI SDK messages -> unified session.
function fromModelMessages(b, messages) {
  const wrapped = messages.some((m) => m?.role === 'user' && rawText(m.content).includes('<user_query>'));
  for (const m of messages) {
    if (!m?.role || m.role === 'system') continue;
    if (m.role === 'user') {
      if (!isInjected(rawText(m.content), wrapped)) b.user(userText(m.content));
      continue;
    }
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    for (const p of parts) {
      if (m.role === 'assistant') {
        if (p.type === 'text') b.text(p.text);
        else if (p.type === 'tool-call') b.tool(p.toolCallId, p.toolName, p.args ?? p.input);
      } else if (m.role === 'tool' && p.type === 'tool-result') {
        b.result(p.toolCallId, toText(p.result ?? p.output ?? p.experimental_content), Boolean(p.isError));
      }
    }
  }
}

function loadDesktop(meta, s, b) {
  const db = openDb(meta.file);
  try {
    const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const composer = parse(get.get(`composerData:${meta.id}`)?.value);
    if (!composer) throw new Error(`Cursor 数据库里找不到会话 ${meta.id}`);
    if (composer.name) s.title = composer.name;
    if (composer.modelConfig?.modelName) s.model = composer.modelConfig.modelName;
    const hashes = stateHashes(composer.conversationState);
    if (hashes.length) {
      fromModelMessages(b, hashes.map((h) => parse(get.get(`agentKv:blob:${h}`)?.value)).filter(Boolean));
      return;
    }
    // Older composers: rebuild from the UI bubbles.
    for (const h of composer.fullConversationHeadersOnly || []) {
      const bubble = parse(get.get(`bubbleId:${meta.id}:${h.bubbleId}`)?.value);
      if (!bubble) continue;
      if (bubble.type === 1) b.user(bubble.text);
      else {
        if (bubble.text) b.text(bubble.text);
        const t = bubble.toolFormerData;
        if (t?.name) { b.tool(t.toolCallId, t.name, t.rawArgs ?? t.params); b.result(t.toolCallId, toText(t.result), t.status === 'error'); }
      }
    }
  } finally { db.close(); }
}

function loadCli(meta, b) {
  const db = openDb(meta.file);
  try {
    const rows = db.prepare('SELECT * FROM blobs').all();
    const messages = rows.map((r) => parse(r.data ?? r.value ?? r.blob)).filter((m) => m?.role);
    fromModelMessages(b, messages);
  } finally { db.close(); }
}

function loadTranscript(meta, b) {
  const records = readJsonl(meta.file);
  const wrapped = records.some((r) => r.role === 'user' && rawText(r.message?.content).includes('<user_query>'));
  for (const r of records) {
    const content = r.message?.content;
    if (r.role === 'user') { if (!isInjected(rawText(content), wrapped)) b.user(userText(content)); }
    else if (r.role === 'assistant') {
      for (const p of Array.isArray(content) ? content : [{ type: 'text', text: content }]) {
        if (p.type === 'text') b.text(String(p.text ?? '').replace(/\n*\[REDACTED\]\s*$/, ''));
        else if (p.type === 'tool_use') b.tool(p.id ?? null, p.name, p.input);
      }
    }
  }
}

export function load(meta) {
  const s = newSession(id, meta.id, { file: meta.file, cwd: meta.cwd, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
  const b = new Builder(s);
  if (meta.source === 'desktop') loadDesktop(meta, s, b);
  else if (meta.source === 'cli') loadCli(meta, b);
  else loadTranscript(meta, b);
  return b.done();
}

// Desktop sessions are reopened from inside Cursor; see src/native/cursor.js.
export function launchCommand() {
  return { cmd: 'cursor', args: ['.'] };
}


