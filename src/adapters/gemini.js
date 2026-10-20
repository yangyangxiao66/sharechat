// Gemini CLI: ~/.gemini/tmp/<project-id>/chats/session-*.jsonl (legacy: .json)
// JSONL is an append log of MessageRecords plus $rewindTo / $patch / $set
// records; replayed the same way as loadConversationRecord in
// packages/core/src/services/chatRecordingService.ts.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { HOME, listDir, readJsonl, readJson, mtime, exists, toText } from '../util.js';
import { newSession, Builder } from '../session.js';

export const id = 'gemini';
export const label = 'Gemini CLI';

const root = () => path.join(process.env.GEMINI_CLI_HOME || HOME, '.gemini');
export function home() { return root(); }

// Shared with qwen, whose legacy layout is the same (~/.qwen/tmp/...).
export function chatFiles(tmpDir) {
  const out = [];
  for (const proj of listDir(tmpDir)) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(tmpDir, proj.name);
    let cwd = '';
    const rootFile = path.join(dir, '.project_root');
    if (exists(rootFile)) cwd = readFileSync(rootFile, 'utf8').trim();
    for (const f of listDir(path.join(dir, 'chats'))) {
      if (f.isFile() && /^session-.*\.jsonl?$/.test(f.name)) out.push({ file: path.join(dir, 'chats', f.name), cwd });
    }
  }
  return out;
}

export function replay(file) {
  if (file.endsWith('.json')) {
    const rec = readJson(file) || {};
    return { meta: rec, messages: rec.messages || [] };
  }
  let meta = {};
  const msgs = new Map();
  const patch = (p) => {
    const m = msgs.get(p.id);
    if (!m) return;
    if ('content' in p) m.content = p.content;
    for (const tp of p.toolCalls || []) {
      const tc = m.toolCalls?.find((t) => t.id === tp.id);
      if (tc && 'result' in tp) tc.result = tp.result;
    }
  };
  for (const r of readJsonl(file)) {
    if (typeof r.$rewindTo === 'string') {
      let hit = false;
      for (const k of [...msgs.keys()]) { if (k === r.$rewindTo) hit = true; if (hit) msgs.delete(k); }
      if (!hit) msgs.clear();
    } else if (r.$patch && typeof r.$patch === 'object') {
      const p = r.$patch;
      if (typeof p.id === 'string') patch(p);
      for (const u of p.updates || []) if (typeof u.id === 'string') patch(u);
      for (const rid of p.removeIds || []) msgs.delete(rid);
      if (Array.isArray(p.orderIds)) {
        const ordered = p.orderIds.filter((k) => msgs.has(k)).map((k) => [k, msgs.get(k)]);
        const keep = new Set(ordered.map(([k]) => k));
        const prefix = [...msgs].filter(([k]) => !keep.has(k));
        msgs.clear();
        for (const [k, v] of [...prefix, ...ordered]) msgs.set(k, v);
      }
    } else if (r.$set && typeof r.$set === 'object') {
      if (Array.isArray(r.$set.messages)) {
        msgs.clear();
        for (const m of r.$set.messages) if (m?.id) msgs.set(m.id, m);
      }
      meta = { ...meta, ...r.$set };
    } else if (typeof r.id === 'string') {
      msgs.set(r.id, r);
    } else if (r.sessionId) {
      meta = { ...meta, ...r };
      for (const m of r.messages || []) if (m?.id) msgs.set(m.id, m);
    }
  }
  return { meta, messages: [...msgs.values()] };
}

// Parts are @google/genai Part objects: {text}, {thought:true,text}, {functionCall}, {functionResponse}.
export function partsText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  const parts = Array.isArray(content) ? content : [content];
  return parts.map((p) => {
    if (typeof p === 'string') return p;
    if (p.thought) return '';
    if (typeof p.text === 'string') return p.text;
    if (p.inlineData || p.fileData) return '[附件]';
    if (p.functionResponse) return toText(p.functionResponse.response?.output ?? p.functionResponse.response);
    return '';
  }).filter(Boolean).join('\n');
}

export function buildFromRecords(agent, meta, file, cwd, messages) {
  const s = newSession(agent, meta.sessionId || path.basename(file).replace(/\.jsonl?$/, ''), {
    file, cwd, title: meta.summary || '', createdAt: meta.startTime || null, updatedAt: meta.lastUpdated || mtime(file),
  });
  const b = new Builder(s);
  for (const m of messages) {
    if (m.type === 'user') b.user(partsText(m.content), m.timestamp);
    else if (m.type === 'gemini') {
      if (m.model) s.model = m.model;
      b.text(partsText(m.content), m.timestamp);
      for (const tc of m.toolCalls || []) {
        b.tool(tc.id, tc.name, tc.args, m.timestamp);
        b.result(tc.id, partsText(tc.result), tc.status === 'error');
      }
    }
  }
  return b.done();
}

export function list() {
  return chatFiles(path.join(root(), 'tmp')).map(({ file, cwd }) => {
    const { meta, messages } = replay(file);
    const first = messages.find((m) => m.type === 'user');
    return {
      agent: id, id: meta.sessionId || path.basename(file), file, cwd,
      title: meta.summary || partsText(first?.content).slice(0, 80),
      createdAt: meta.startTime || null, updatedAt: mtime(file),
    };
  });
}

export function load(meta) {
  const { meta: m, messages } = replay(meta.file);
  return buildFromRecords(id, m, meta.file, meta.cwd, messages);
}

export function launchCommand(prompt) {
  return { cmd: 'gemini', args: ['-i', prompt] };
}
