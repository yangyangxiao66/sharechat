// OpenCode: storage is an internal SQLite database whose schema changes between
// releases, so this adapter only uses the official CLI:
//   opencode session list --format json
//   opencode session export <id>      (SessionTransfer.Data: { info, messages })
// Both the v2 message shape (type: user|assistant|shell|compaction...) and the
// v1 shape ({ info: { role }, parts: [...] }) are understood.
import { runCli, toText } from '../util.js';
import { newSession, Builder } from '../session.js';

export const id = 'opencode';
export const label = 'OpenCode';

export function home() { return null; }

function parseJsonOut(out) {
  if (!out) return null;
  const i = out.search(/[[{]/);
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i)); } catch { return null; }
}

const ms = (v) => (typeof v === 'number' ? new Date(v).toISOString() : v || null);
const dirOf = (info) => info?.directory || info?.location?.directory || info?.path || '';

export function list() {
  const data = parseJsonOut(runCli('opencode', ['session', 'list', '--format', 'json', '-n', '200']));
  const rows = Array.isArray(data) ? data : data?.data || [];
  return rows.map((r) => ({
    agent: id, id: r.id, file: null,
    cwd: dirOf(r), title: r.title || '',
    createdAt: ms(r.time?.created ?? r.created), updatedAt: ms(r.time?.updated ?? r.updated),
  }));
}

function toolOutput(state) {
  if (!state) return '';
  if (state.output != null) return toText(state.output);
  if (state.content) return toText(state.content);
  if (state.error) return toText(state.error.message ?? state.error);
  return '';
}

function loadV1(b, s, messages) {
  for (const m of messages) {
    const role = m.info?.role;
    const ts = ms(m.info?.time?.created);
    if (role === 'assistant' && m.info?.modelID) s.model = m.info.modelID;
    for (const p of m.parts || []) {
      if (p.type === 'text' && !p.synthetic) role === 'user' ? b.user(p.text, ts) : b.text(p.text, ts);
      else if (p.type === 'file' && role === 'user') b.user(`[文件] ${p.filename || p.url || ''}`, ts);
      else if (p.type === 'tool') {
        b.tool(p.callID || p.id, p.tool, p.state?.input, ts);
        b.result(p.callID || p.id, toolOutput(p.state), p.state?.status === 'error');
      }
    }
  }
}

function loadV2(b, s, messages) {
  for (const m of messages) {
    const ts = ms(m.time?.created);
    switch (m.type) {
      case 'user':
        b.user([m.text, ...(m.files || []).map((f) => `[文件] ${f.name || f.path || f.uri || ''}`)].filter(Boolean).join('\n'), ts);
        break;
      case 'assistant':
        if (m.model?.id) s.model = m.model.id;
        for (const c of m.content || []) {
          if (c.type === 'text') b.text(c.text, ts);
          else if (c.type === 'tool') {
            b.tool(c.id, c.name, c.state?.input, ts);
            b.result(c.id, toolOutput(c.state), c.state?.status === 'error');
          }
        }
        break;
      case 'shell': {
        const part = b.tool(m.shellID, 'shell', m.command, ts);
        part.output = toText(m.output);
        break;
      }
      case 'compaction':
        if (m.summary) b.user(`[上一段上下文的压缩摘要]\n${m.summary}`, ts);
        break;
    }
  }
}

export function load(meta) {
  const out = runCli('opencode', ['session', 'export', meta.id], { timeout: 120000 })
    ?? runCli('opencode', ['export', meta.id], { timeout: 120000 });
  const data = parseJsonOut(out);
  if (!data) throw new Error(`opencode 导出会话 ${meta.id} 失败（确认 opencode 已安装且会话存在）`);
  const info = data.info || {};
  const s = newSession(id, info.id || meta.id, {
    cwd: dirOf(info) || meta.cwd, title: info.title || meta.title,
    createdAt: ms(info.time?.created) || meta.createdAt, updatedAt: ms(info.time?.updated) || meta.updatedAt,
  });
  const b = new Builder(s);
  const msgs = data.messages || [];
  if (msgs.some((m) => m.info)) loadV1(b, s, msgs);
  else loadV2(b, s, msgs);
  return b.done();
}

export function launchCommand(prompt) {
  return { cmd: 'opencode', args: ['--prompt', prompt] };
}
