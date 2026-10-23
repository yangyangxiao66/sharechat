// Write a native Codex rollout so `codex resume <id>` opens it with the full
// history. Mirrors Codex's own external-agent importer
// (codex-rs/external-agent-migration/src/sessions/export.rs): each turn is
// TurnStarted, UserMessage + user ResponseItem, AgentMessage + assistant
// ResponseItem(s), TurnComplete, plus a TokenCount so Codex can auto-compact
// an oversized imported history.
//
// The file goes to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
// When the thread is not yet in Codex's SQLite index, `codex resume <id>`
// falls back to a filename scan and repairs the index
// (codex-rs/rollout/src/list.rs, find_thread_path_by_id_str_in_subdir).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { home } from '../adapters/codex.js';
import { flatten, timeline, uuidv7 } from './flatten.js';
import { historyBudget } from './budget.js';

const pad = (n) => String(n).padStart(2, '0');
const fileStamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;

// The desktop app resolves the thread's provider through config.toml; a null
// provider becomes an empty string and the thread fails to open.
function configDefaults() {
  const defaults = { modelProvider: 'openai', model: '' };
  try {
    const text = fs.readFileSync(path.join(home(), 'config.toml'), 'utf8');
    let topLevel = true;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) { topLevel = false; continue; }
      if (!topLevel) continue;
      const provider = line.match(/^model_provider\s*=\s*["']([^"']+)["']/);
      if (provider) defaults.modelProvider = provider[1];
      const model = line.match(/^model\s*=\s*["']([^"']+)["']/);
      if (model) defaults.model = model[1];
    }
  } catch {
    // Missing config falls back to Codex's built-in provider.
  }
  return defaults;
}

export function writeCodexSession(session, sourceLabel, {
  cwd,
  maxTokens,
  modelProvider = '',
  originator = 'sharechat',
  source = 'cli',
  threadSource = '',
  historyMode = '',
} = {}) {
  const msgs = flatten(session, sourceLabel, { maxTokens: maxTokens ?? historyBudget('codex') });
  const times = timeline(msgs);
  const id = uuidv7();
  const now = new Date();
  const provider = modelProvider || configDefaults().modelProvider;
  const items = [];
  const add = (ts, type, payload) => items.push({ timestamp: ts.toISOString(), ordinal: items.length, type, payload });
  const secs = (d) => Math.floor(d.getTime() / 1000);

  add(now, 'session_meta', {
    session_id: id,
    id,
    timestamp: now.toISOString(),
    cwd,
    originator,
    cli_version: '0.0.0',
    source,
    ...(threadSource ? { thread_source: threadSource } : {}),
    ...(historyMode ? { history_mode: historyMode } : {}),
    model_provider: provider,
    base_instructions: null,
  });

  let turn = 0, open = null, bytes = 0;
  const close = (completedAt) => {
    if (!open) return;
    add(completedAt ?? open.started, 'event_msg', {
      type: 'task_complete', turn_id: open.id, last_agent_message: null,
      started_at: secs(open.started), ...(completedAt ? { completed_at: secs(completedAt) } : {}),
    });
    open = null;
  };
  msgs.forEach((m, i) => {
    const ts = times[i];
    bytes += Buffer.byteLength(m.text);
    if (m.role === 'user') {
      close(null);
      open = { id: `sharechat-import-turn-${++turn}`, started: ts };
      add(ts, 'event_msg', { type: 'task_started', turn_id: open.id, started_at: secs(ts), model_context_window: null });
      add(ts, 'event_msg', { type: 'user_message', message: m.text });
      add(ts, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: m.text }] });
      add(ts, 'event_msg', {
        type: 'item_completed',
        thread_id: id,
        turn_id: open.id,
        item: { type: 'UserMessage', id: uuidv7(), content: [{ type: 'text', text: m.text }] },
        started_at_ms: ts.getTime(),
        completed_at_ms: ts.getTime(),
      });
    } else {
      add(ts, 'event_msg', { type: 'agent_message', message: m.text, phase: null });
      add(ts, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
      if (open) {
        add(ts, 'event_msg', {
          type: 'item_completed',
          thread_id: id,
          turn_id: open.id,
          item: { type: 'AgentMessage', id: `msg_${randomBytes(24).toString('hex')}`, content: [{ type: 'Text', text: m.text }] },
          started_at_ms: ts.getTime(),
          completed_at_ms: ts.getTime(),
        });
      }
    }
  });
  const last = times[times.length - 1] ?? now;
  const tokens = Math.ceil(bytes / 4);
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: tokens };
  add(last, 'event_msg', { type: 'agent_message', message: '<EXTERNAL SESSION IMPORTED>', phase: null });
  add(last, 'event_msg', { type: 'token_count', info: { total_token_usage: usage, last_token_usage: usage, model_context_window: null }, rate_limits: null });
  close(last);

  const dir = path.join(home(), 'sessions', String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${fileStamp(now)}-${id}.jsonl`);
  fs.writeFileSync(file, items.map((x) => JSON.stringify(x)).join('\n') + '\n');

  // Codex reads thread titles from session_index.jsonl.
  if (session.title) {
    const entry = { id, thread_name: `${session.title}（来自 ${sourceLabel}）`, updated_at: now.toISOString() };
    fs.appendFileSync(path.join(home(), 'session_index.jsonl'), JSON.stringify(entry) + '\n');
  }
  return { sessionId: id, file, resume: { cmd: 'codex', args: ['resume', id] } };
}

// ChatGPT desktop reads the same rollouts but identifies its own threads by the
// Codex Desktop originator; the codex:// deep link indexes and opens the thread.
export function writeChatGptSession(session, sourceLabel, opts = {}) {
  const r = writeCodexSession(session, sourceLabel, {
    ...opts,
    originator: 'Codex Desktop',
    source: 'vscode',
    threadSource: 'user',
    historyMode: 'paginated',
  });
  return { sessionId: r.sessionId, file: r.file, openUrl: `codex://threads/${r.sessionId}` };
}
