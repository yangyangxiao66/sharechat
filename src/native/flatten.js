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

// A tool call without its output, for shrinking older history.
function toolBrief(p) {
  return `[external_agent_tool_call: ${p.name}] ${summarizeInput(p.input, 200)}${p.isError ? '（出错）' : ''}`;
}

// Rough token count: CJK and other non-ASCII ~1 token per char, ASCII ~4 chars per token.
export function estimateTokens(s) {
  let ascii = 0, other = 0;
  for (let i = 0; i < s.length; i++) (s.charCodeAt(i) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4 + other);
}

export const DEFAULT_MAX_TOKENS = 120000;
const KEEP_RECENT = 6;
const HEAD_MAX = 4000;

// Shrink history to fit `budget` tokens. The target agent compacts by sending
// the whole history to its model, so a history larger than the model's context
// can never be compacted. Older messages lose tool outputs first, then the
// oldest are dropped (the first user request is always kept), and finally the
// remaining messages are clipped.
function fit(msgs, budget) {
  const size = (m) => estimateTokens(m.text);
  let total = msgs.reduce((n, m) => n + size(m), 0);
  if (!budget || total <= budget) return msgs;

  for (let i = 0; i < msgs.length - KEEP_RECENT && total > budget; i++) {
    if (msgs[i].brief == null) continue;
    total += estimateTokens(msgs[i].brief) - size(msgs[i]);
    msgs[i].text = msgs[i].brief;
  }
  if (total <= budget) return msgs;

  const head = msgs[0]?.role === 'user' ? msgs.shift() : null;
  if (head) {
    head.text = clip(head.text, HEAD_MAX);
    total = estimateTokens(head.text) + msgs.reduce((n, m) => n + size(m), 0);
  }
  let dropped = 0;
  // Drop oldest; with a head, the first kept message must be the assistant's.
  while (msgs.length > 1 && (total > budget || (head && msgs[0].role === 'user'))) {
    total -= size(msgs.shift());
    dropped++;
  }
  const gap = `[sharechat：原会话过长，省略了 ${dropped} 条较早的消息，以下是最近的对话。]`;
  if (head && dropped) head.text += `\n\n${gap}`;
  if (head && msgs[0]?.role === 'user') msgs[0].text = `${head.text}\n\n${msgs[0].text}`;
  else if (head) msgs.unshift(head);
  else if (dropped) msgs.unshift({ role: 'user', text: gap });

  if (total > budget) {
    const ratio = budget / total;
    for (const m of msgs) m.text = clip(m.text, Math.max(500, Math.floor(m.text.length * ratio)));
  }
  return msgs;
}

export function flatten(session, sourceLabel, { maxTokens = DEFAULT_MAX_TOKENS } = {}) {
  let msgs = [];
  const push = (role, text, ts, brief = text) => {
    text = (text ?? '').trim();
    brief = (brief ?? '').trim();
    if (!text) return;
    const last = msgs[msgs.length - 1];
    if (last?.role === role) {
      last.text += '\n\n' + text;
      last.brief += '\n\n' + brief;
    } else msgs.push({ role, text, ts, brief });
  };
  for (const t of toTurns(session)) {
    if (t.user) push('user', t.user.text, t.user.ts, clip(t.user.text, HEAD_MAX));
    for (const r of t.replies) {
      push('assistant',
        r.parts.map((p) => (p.type === 'text' ? p.text : toolNote(p))).join('\n\n'), r.ts,
        r.parts.map((p) => (p.type === 'text' ? clip(p.text, 2000) : toolBrief(p))).join('\n\n'));
    }
  }
  msgs = fit(msgs, maxTokens).map(({ brief, ...m }) => m);
  const note = `[本会话由 sharechat 从 ${sourceLabel} 导入（原会话 ID ${session.id}）。之前的工具调用由原来的助手执行，文件请以磁盘当前状态为准。]`;
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
