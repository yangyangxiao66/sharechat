// OpenAI Codex CLI: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]
// Lines are RolloutLine { timestamp, type, payload }; conversation content lives
// in `response_item` payloads (ResponseItem in codex-rs/protocol/src/models.rs).
import path from 'node:path';
import { HOME, walkFiles, headJsonl, readJsonl, mtime, exists, toText, tryParse, parseJsonl } from '../util.js';
import { readFileSync } from 'node:fs';
import { newSession, Builder } from '../session.js';

const root = () => process.env.CODEX_HOME || path.join(HOME, '.codex');

export const id = 'codex';
export const label = 'Codex';

export function home() { return root(); }

function threadNames() {
  const file = path.join(root(), 'session_index.jsonl');
  const names = new Map();
  if (!exists(file)) return names;
  for (const r of parseJsonl(readFileSync(file, 'utf8'))) {
    if (r.id && r.thread_name) names.set(r.id, r.thread_name);
  }
  return names;
}

const isRollout = (name) => /^rollout-.*\.jsonl(\.zst)?$/.test(name);

// Harness-injected user messages (environment, AGENTS.md, permissions...) are
// a single XML-ish block or a known heading.
function realUserText(text) {
  const t = text.trim();
  if (!t) return '';
  const req = t.match(/## My request(?: for Codex)?:\s*([\s\S]*)$/);
  if (req) return req[1].trim();
  if (/^<([a-z_\-]+)[^>]*>[\s\S]*<\/\1>$/i.test(t)) return '';
  if (/^# AGENTS\.md instructions/i.test(t)) return '';
  return t;
}

function outputText(out) {
  if (out == null) return '';
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return toText(out);
  if (typeof out.content === 'string') return out.content;
  if (Array.isArray(out.content)) return toText(out.content);
  return toText(out);
}

export function list() {
  const names = threadNames();
  const files = [
    ...walkFiles(path.join(root(), 'sessions'), isRollout),
    ...walkFiles(path.join(root(), 'archived_sessions'), isRollout),
  ];
  return files.map((file) => {
    const head = headJsonl(file, 64 * 1024);
    const meta = head.find((r) => r.type === 'session_meta')?.payload ?? {};
    const sid = meta.id || meta.session_id || file.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/)?.[1] || path.basename(file);
    return {
      agent: id, id: sid, file,
      cwd: meta.cwd || '',
      title: names.get(sid) || '',
      createdAt: meta.timestamp || null,
      updatedAt: mtime(file),
    };
  });
}

export function load(meta) {
  const s = newSession(id, meta.id, { file: meta.file, cwd: meta.cwd, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
  const b = new Builder(s);
  for (const line of readJsonl(meta.file)) {
    const p = line.payload;
    if (!p) continue;
    if (line.type === 'session_meta') { s.cwd ||= p.cwd; continue; }
    if (line.type === 'turn_context') { if (p.model) s.model = p.model; if (p.cwd) s.cwd = p.cwd; continue; }
    if (line.type !== 'response_item') continue;
    const ts = line.timestamp;
    switch (p.type) {
      case 'message': {
        const text = (p.content || []).map((c) => c.text ?? (c.type === 'input_image' ? '[图片]' : '')).join('\n');
        if (p.role === 'user') b.user(realUserText(text), ts);
        else if (p.role === 'assistant') b.text(text, ts);
        break;
      }
      case 'function_call':
        b.tool(p.call_id, p.namespace ? `${p.namespace}.${p.name}` : p.name, tryParse(p.arguments), ts);
        break;
      case 'custom_tool_call':
        b.tool(p.call_id, p.name, p.input, ts);
        break;
      case 'local_shell_call':
        b.tool(p.call_id, 'shell', p.action?.command ?? p.action, ts);
        break;
      case 'web_search_call':
        b.tool(p.id, 'web_search', p.action?.query ?? p.action, ts);
        break;
      case 'tool_search_call':
        b.tool(p.call_id, 'tool_search', p.arguments, ts);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        b.result(p.call_id, outputText(p.output), p.output?.success === false);
        break;
    }
  }
  return b.done();
}

export function launchCommand(prompt) {
  return { cmd: 'codex', args: [prompt] };
}
