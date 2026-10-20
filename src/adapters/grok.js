// Grok Build (xai-org/grok-build): sessions live under
// $GROK_HOME/sessions/<encode_cwd_dirname(cwd)>/<sessionId>/, with the model
// transcript in chat_history.jsonl (ConversationItem, serde tag "type") and
// metadata in summary.json (`Summary`, xai-grok-shell/src/session/persistence.rs).
// Long cwds use a hashed dirname with a `.cwd` marker, so the cwd is taken from
// summary.json. When chat_history.jsonl is missing we fall back to the
// official `grok export <id>` Markdown transcript.
import path from 'node:path';
import { HOME, listDir, readJsonl, readJson, exists, mtime, stripBlocks, tryParse, toText, runCli } from '../util.js';
import { newSession, Builder } from '../session.js';

export const id = 'grok';
export const label = 'Grok Build';

const root = () => process.env.GROK_HOME || path.join(HOME, '.grok');
export function home() { return root(); }

const NOISE_TAGS = ['user_info', 'rules', 'system-reminder', 'agent_skills', 'project_layout', 'git_status'];

function decodeDir(name) {
  try { return decodeURIComponent(name); } catch { return name; }
}

export function list() {
  const out = [];
  const base = path.join(root(), 'sessions');
  for (const proj of listDir(base)) {
    if (!proj.isDirectory()) continue;
    for (const sess of listDir(path.join(base, proj.name))) {
      if (!sess.isDirectory()) continue;
      const dir = path.join(base, proj.name, sess.name);
      const sum = readJson(path.join(dir, 'summary.json')) || {};
      const history = path.join(dir, 'chat_history.jsonl');
      if (!exists(history) && !sum.info) continue;
      out.push({
        agent: id, id: sum.info?.id || sess.name, file: exists(history) ? history : null,
        cwd: sum.info?.cwd || decodeDir(proj.name),
        title: sum.generated_title || sum.session_summary || '',
        createdAt: sum.created_at || null,
        updatedAt: sum.last_active_at || sum.updated_at || mtime(history),
      });
    }
  }
  return out;
}

function userText(content) {
  const raw = typeof content === 'string' ? content : (content || []).map((c) => c.text ?? (c.type?.includes('image') ? '[图片]' : '')).join('\n');
  const queries = [...raw.matchAll(/<user_query>([\s\S]*?)<\/user_query>/g)].map((m) => m[1].trim());
  if (queries.length) return queries.join('\n');
  const rest = stripBlocks(raw, NOISE_TAGS);
  return /^<[a-z_\-]+[\s>]/i.test(rest) ? '' : rest;
}

export function load(meta) {
  const s = newSession(id, meta.id, { file: meta.file, cwd: meta.cwd, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt });
  if (!meta.file) {
    const md = runCli('grok', ['export', meta.id], { timeout: 120000 });
    if (!md) throw new Error(`grok export ${meta.id} 失败`);
    s.rawMarkdown = md;
    return s;
  }
  const b = new Builder(s);
  for (const r of readJsonl(meta.file)) {
    if (r.type === 'user') b.user(userText(r.content));
    else if (r.type === 'assistant') {
      if (r.model_id) s.model = r.model_id;
      b.text(typeof r.content === 'string' ? r.content : toText(r.content));
      for (const tc of r.tool_calls || []) b.tool(tc.id, tc.name, tryParse(tc.arguments));
    } else if (r.type === 'tool_result') {
      b.result(r.tool_call_id, toText(r.content), r.is_error);
    }
  }
  return b.done();
}

export function launchCommand(prompt) {
  return { cmd: 'grok', args: [prompt] };
}
