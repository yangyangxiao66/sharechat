// Flatten a unified session into strictly alternating user/assistant text
// messages, the common denominator every agent can resume from.
//
// Tool calls cannot be replayed as native tool calls in another agent (its
// tool set differs, and a dangling call without a matching result breaks the
// history), so they are written as tagged text notes. The tag format matches
// Codex's official external-agent importer
// (codex-rs/external-agent-migration/src/sessions/records_common.rs).
import { clip } from '../util.js';
import { summarizeInput, toTurns } from '../render.js';

const TOOL_RESULT_MAX = 4000;

function toolNote(p) {
  const lines = [`[external_agent_tool_call: ${p.name}]`, `input: ${summarizeInput(p.input, 2000)}`, '[/external_agent_tool_call]'];
  if (p.output) {
    lines.push(
      p.isError ? '[external_agent_tool_result: error]' : '[external_agent_tool_result]',
      clip(p.output, TOOL_RESULT_MAX),
      '[/external_agent_tool_result]',
    );
  }
  return lines.join('\n');
}

export function flatten(session, sourceLabel) {
  const msgs = [];
  const push = (role, text, ts) => {
    text = (text ?? '').trim();
    if (!text) return;
    const last = msgs[msgs.length - 1];
    if (last?.role === role) last.text += '\n\n' + text;
    else msgs.push({ role, text, ts });
  };
  for (const t of toTurns(session)) {
    if (t.user) push('user', t.user.text, t.user.ts);
    for (const r of t.replies) {
      push('assistant', r.parts.map((p) => (p.type === 'text' ? p.text : toolNote(p))).join('\n\n'), r.ts);
    }
  }
  const note = `[本会话由 openchat 从 ${sourceLabel} 导入（原会话 ID ${session.id}）。之前的工具调用由原来的助手执行，文件请以磁盘当前状态为准。]`;
  if (msgs[0]?.role === 'user') msgs[0].text = `${note}\n\n${msgs[0].text}`;
  else msgs.unshift({ role: 'user', text: note });
  return msgs;
}

// Spread timestamps so every record has a valid, increasing time.
export function timeline(msgs, end = Date.now()) {
  const start = end - msgs.length * 1000;
  return msgs.map((m, i) => {
    const t = Date.parse(m.ts);
    return Number.isFinite(t) ? new Date(t) : new Date(start + i * 1000);
  });
}

// RFC 9562 UUIDv7 (Codex thread ids are v7; any UUID works elsewhere).
export function uuidv7() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) { b[i] = Number(ms & 0xffn); ms >>= 8n; }
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
