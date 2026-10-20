// Cursor (closed source) storage, as observed in Cursor Desktop and as read by
// Grok Build's resume-cursor session_reader.py and Codex's external-agent
// importer (records_cur.rs):
//
//   <User>/globalStorage/state.vscdb   (SQLite)
//     composerHeaders(composerId, workspaceId, createdAt, lastUpdatedAt,
//                     isArchived, isSubagent, recency, checkpointAt, value)
//     cursorDiskKV  composerData:<composerId>          composer JSON
//                   bubbleId:<composerId>:<bubbleId>   UI message JSON
//                   agentKv:blob:<sha256>              model message JSON
//   <User>/workspaceStorage/<workspaceId>/workspace.json  { folder: file URI }
//   ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl
//   ~/.cursor/chats/<md5(cwd)>/<id>/store.db         (Cursor CLI)
//
// composerData.conversationState is "~" + base64(protobuf). Field 1 repeats
// the sha256 of each model message blob, in order; the blobs are AI SDK
// messages: { role: system|user|assistant|tool, content }.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME } from './util.js';

export function cursorUserDir() {
  if (process.env.CURSOR_USER_DIR) return process.env.CURSOR_USER_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'Cursor', 'User');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'Cursor', 'User');
}

export const cursorHome = () => process.env.CURSOR_HOME || path.join(HOME, '.cursor');
export const globalDbPath = () => path.join(cursorUserDir(), 'globalStorage', 'state.vscdb');

const normalize = (p) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
};

function uriToPath(uri) {
  try { return fileURLToPath(uri); } catch { return null; }
}

// workspaceId <-> folder, from workspaceStorage/*/workspace.json
export function workspaces() {
  const dir = path.join(cursorUserDir(), 'workspaceStorage');
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const ws = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'workspace.json'), 'utf8'));
      const folder = ws.folder && uriToPath(ws.folder);
      if (folder) out.push({ id: e.name, folder });
    } catch { /* no workspace.json */ }
  }
  return out;
}

export function workspaceIdFor(cwd) {
  const want = normalize(cwd);
  return workspaces().find((w) => normalize(w.folder) === want)?.id ?? null;
}

// ---- protobuf (just enough for conversationState) ----
function readVarint(b, at) {
  let x = 0, shift = 0, i = at;
  for (;;) {
    const byte = b[i++];
    x += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [x, i];
    shift += 7;
  }
}

export function decodeFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag; [tag, i] = readVarint(buf, i);
    const field = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 0) { let v; [v, i] = readVarint(buf, i); out.push({ field, wt, value: v }); }
    else if (wt === 2) { let len; [len, i] = readVarint(buf, i); out.push({ field, wt, value: buf.subarray(i, i + len) }); i += len; }
    else if (wt === 1) { out.push({ field, wt, value: buf.subarray(i, i + 8) }); i += 8; }
    else if (wt === 5) { out.push({ field, wt, value: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error(`unsupported protobuf wire type ${wt}`);
  }
  return out;
}

function varint(n) {
  const bytes = [];
  let v = n;
  do {
    let byte = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

export function encodeFields(fields) {
  return Buffer.concat(fields.map(({ field, wt, value }) => {
    const tag = varint(field * 8 + wt);
    if (wt === 0) return Buffer.concat([tag, varint(value)]);
    if (wt === 2) { const v = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8'); return Buffer.concat([tag, varint(v.length), v]); }
    return Buffer.concat([tag, value]);
  }));
}

export function stateHashes(conversationState) {
  if (typeof conversationState !== 'string' || conversationState.length < 2) return [];
  const fields = decodeFields(Buffer.from(conversationState.replace(/^~/, ''), 'base64'));
  return fields.filter((f) => f.field === 1 && f.wt === 2 && f.value.length === 32).map((f) => f.value.toString('hex'));
}

// Cursor keeps composers in memory and writes them back, so the global DB may
// only be modified while Cursor is closed.
export function isCursorRunning() {
  const r = process.platform === 'win32'
    ? spawnSync('tasklist', ['/FI', 'IMAGENAME eq Cursor.exe', '/NH'], { encoding: 'utf8', windowsHide: true })
    : spawnSync('pgrep', ['-x', process.platform === 'darwin' ? 'Cursor' : 'cursor'], { encoding: 'utf8' });
  return process.platform === 'win32' ? /Cursor\.exe/i.test(r.stdout || '') : r.status === 0;
}
