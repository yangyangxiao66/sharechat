// Write a native Grok Build session so `grok --resume <id>` opens it.
// Layout per xai-org/grok-build:
//   $GROK_HOME/sessions/<encode_cwd_dirname(cwd)>/<id>/
//     summary.json        `Summary` (xai-grok-shell/src/session/persistence.rs);
//                         a dir without it is not a resumable session
//     chat_history.jsonl  `ConversationItem` lines, serde tag "type"
//                         (xai-grok-sampling-types/src/conversation.rs)
//     updates.jsonl       ACP session/update events, streamed by the TUI for display
// No system item is written: on cold load Grok calls
// replace_or_insert_system_head (xai-chat-state/src/conversation_util.rs),
// which inserts the freshly rendered system prompt at the head.
import fs from 'node:fs';
import path from 'node:path';
import { home, list } from '../adapters/grok.js';
import { readJson } from '../util.js';
import { flatten, timeline, uuidv7 } from './flatten.js';
import { blake3Hex } from './blake3.js';

// Rust `urlencoding::encode`: everything but A-Z a-z 0-9 - _ . ~ is escaped
// (unlike encodeURIComponent, which keeps ! ' ( ) *).
const urlencode = (s) => [...Buffer.from(s, 'utf8')]
  .map((b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0')))
  .join('');

function slugify(input, max) {
  let out = '', dash = false;
  for (const c of input.toLowerCase()) {
    if (/^[a-z0-9]$/.test(c)) { out += c; dash = false; } else if (!dash) { out += '-'; dash = true; }
  }
  return [...out.replace(/^-+|-+$/g, '')].slice(0, max).join('');
}

// xai-grok-config/src/paths.rs encode_cwd_dirname: URL-encoded when it fits
// in 255 bytes, else `{slug}-{blake3_hex16}` plus a `.cwd` marker file.
export function encodeCwdDirname(cwd) {
  const encoded = urlencode(cwd);
  if (encoded.length <= 255) return { name: encoded, hashed: false };
  const slug = slugify(path.basename(cwd), 40) || 'workspace';
  return { name: `${slug}-${blake3Hex(cwd).slice(0, 16)}`, hashed: true };
}

// summary.json without current_model_id fails to deserialize (it is a
// required `Summary` field), so the session is skipped. Prefer the model of
// the newest Grok session when still offered, else the first cached model.
function pickModel() {
  const offered = Object.keys(readJson(path.join(home(), 'models_cache.json'))?.models ?? {});
  const newest = list().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const recent = newest && readJson(path.join(path.dirname(newest.file ?? ''), 'summary.json'))?.current_model_id;
  if (recent && (!offered.length || offered.includes(recent))) return recent;
  return offered[0] || 'grok-4.7';
}

export function writeGrokSession(session, sourceLabel, { cwd }) {
  const msgs = flatten(session, sourceLabel);
  const times = timeline(msgs);
  const id = uuidv7();
  const history = [];
  const updates = [];
  let prompt = -1, event = 0;
  const update = (ts, method, u) => updates.push({
    timestamp: Math.floor(ts.getTime() / 1000), method,
    params: { sessionId: id, update: u, _meta: { eventId: `${id}-${++event}`, agentTimestampMs: ts.getTime() } },
  });
  msgs.forEach((m, i) => {
    const ts = times[i];
    if (m.role === 'user') {
      if (prompt >= 0) update(ts, '_x.ai/session/update', { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' });
      prompt++;
      history.push({ type: 'user', content: [{ type: 'text', text: `<user_query>\n${m.text}\n</user_query>` }], prompt_index: prompt });
      update(ts, 'session/update', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: m.text }, _meta: { promptIndex: prompt } });
    } else {
      history.push({ type: 'assistant', content: m.text });
      update(ts, 'session/update', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: m.text } });
    }
  });
  const last = times[times.length - 1] ?? new Date();
  update(last, '_x.ai/session/update', { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' });

  const title = `${session.title || '导入的会话'}（来自 ${sourceLabel}）`;
  const now = new Date().toISOString();
  const summary = {
    info: { id, cwd: path.resolve(cwd) },
    session_summary: title,
    generated_title: title,
    created_at: times[0]?.toISOString() ?? now,
    updated_at: now,
    last_active_at: now,
    num_messages: history.length,
    num_chat_messages: history.length,
    chat_format_version: 1,
    current_model_id: pickModel(),
    grok_home: home(),
  };

  const absCwd = path.resolve(cwd);
  const { name, hashed } = encodeCwdDirname(absCwd);
  const cwdDir = path.join(home(), 'sessions', name);
  const dir = path.join(cwdDir, id);
  fs.mkdirSync(dir, { recursive: true });
  if (hashed && !fs.existsSync(path.join(cwdDir, '.cwd'))) fs.writeFileSync(path.join(cwdDir, '.cwd'), absCwd);
  const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'chat_history.jsonl'), jsonl(history));
  fs.writeFileSync(path.join(dir, 'updates.jsonl'), jsonl(updates));
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return { sessionId: id, file: path.join(dir, 'chat_history.jsonl'), resume: { cmd: 'grok', args: ['--resume', id] } };
}
