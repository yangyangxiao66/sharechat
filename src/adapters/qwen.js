// Qwen Code: ~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
// Lines are ChatRecord { uuid, parentUuid, type, subtype?, cwd, message: Content }
// (packages/core/src/services/chatRecordingService.ts). Older builds used the
// Gemini CLI layout under ~/.qwen/tmp, which is handled via the gemini adapter.
import path from 'node:path';
import { HOME, listDir, headJsonl, readJsonl, mtime, toText } from '../util.js';
import { newSession, Builder } from '../session.js';
import { chatFiles, replay, buildFromRecords, partsText } from './gemini.js';

export const id = 'qwen';
export const label = 'Qwen Code';

const root = () => process.env.QWEN_HOME || path.join(HOME, '.qwen');
export function home() { return root(); }

function projectChats() {
  const out = [];
  const dir = path.join(root(), 'projects');
  for (const p of listDir(dir)) {
    if (!p.isDirectory()) continue;
    for (const f of listDir(path.join(dir, p.name, 'chats'))) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(dir, p.name, 'chats', f.name));
    }
  }
  return out;
}

const CONVERSATION = new Set(['user', 'assistant', 'tool_result']);

function activeChain(records) {
  const byId = new Map();
  let leaf = null;
  for (const r of records) {
    if (!r.uuid) continue;
    byId.set(r.uuid, r);
    if (CONVERSATION.has(r.type)) leaf = r;
  }
  const chain = [];
  const seen = new Set();
  for (let r = leaf; r && !seen.has(r.uuid); r = r.parentUuid ? byId.get(r.parentUuid) : null) {
    seen.add(r.uuid);
    chain.push(r);
  }
  return chain.reverse();
}

export function list() {
  const current = projectChats().map((file) => {
    const head = headJsonl(file, 128 * 1024);
    const first = head.find((r) => r.cwd);
    const title = head.find((r) => r.subtype === 'custom_title')?.systemPayload?.customTitle
      || partsText(head.find((r) => r.type === 'user' && !r.subtype)?.message?.parts).slice(0, 80);
    return {
      agent: id, id: path.basename(file, '.jsonl'), file, format: 'chatrecord',
      cwd: first?.cwd || '', title, createdAt: first?.timestamp || null, updatedAt: mtime(file),
    };
  });
  const legacy = chatFiles(path.join(root(), 'tmp')).map(({ file, cwd }) => ({
    agent: id, id: path.basename(file).replace(/\.jsonl?$/, ''), file, format: 'gemini', cwd, title: '', updatedAt: mtime(file),
  }));
  return [...current, ...legacy];
}

export function load(meta) {
  if (meta.format === 'gemini') {
    const { meta: m, messages } = replay(meta.file);
    return buildFromRecords(id, m, meta.file, meta.cwd, messages);
  }
  const records = readJsonl(meta.file);
  const s = newSession(id, meta.id, { file: meta.file, cwd: meta.cwd, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
  for (const r of records) {
    if (r.subtype === 'custom_title' && r.systemPayload?.customTitle) s.title = r.systemPayload.customTitle;
    if (r.subtype === 'session_model' && r.systemPayload?.model) s.model = r.systemPayload.model;
  }
  const b = new Builder(s);
  for (const r of activeChain(records)) {
    const parts = r.message?.parts || [];
    if (r.type === 'user') {
      if (r.subtype && r.subtype !== 'mid_turn_user_message') continue;
      b.user(partsText(parts), r.timestamp);
    } else if (r.type === 'assistant') {
      if (r.model) s.model = r.model;
      for (const p of parts) {
        if (p.thought) continue;
        if (typeof p.text === 'string') b.text(p.text, r.timestamp);
        else if (p.functionCall) b.tool(p.functionCall.id, p.functionCall.name, p.functionCall.args, r.timestamp);
      }
    } else if (r.type === 'tool_result') {
      for (const p of parts) {
        const fr = p.functionResponse;
        if (!fr) continue;
        const resp = fr.response ?? {};
        b.result(fr.id, toText(resp.output ?? resp.error ?? resp), Boolean(resp.error));
      }
    }
  }
  return b.done();
}

export function launchCommand(prompt) {
  return { cmd: 'qwen', args: ['-i', prompt] };
}
