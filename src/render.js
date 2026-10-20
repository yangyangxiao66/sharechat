// Render a unified session as a Markdown handoff document that any agent can
// read. Older turns are progressively compressed to fit a character budget.
import { clip, oneLine } from './util.js';

const LIMITS = [
  // level 0: full detail, 1: compact, 2: minimal
  { user: 8000, text: 6000, input: 1000, output: 1200 },
  { user: 3000, text: 2000, input: 200, output: 0 },
  { user: 600, text: 800, input: 0, output: 0 },
];

const INPUT_KEYS = ['command', 'cmd', 'file_path', 'path', 'filePath', 'target_file', 'target_directory', 'pattern', 'query', 'url', 'description', 'prompt'];

function fence(body, lang = '') {
  const runs = String(body).match(/`{3,}/g) || [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = '`'.repeat(n);
  return `${f}${lang}\n${body}\n${f}`;
}

export function summarizeInput(input, max = 200) {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input, max);
  if (Array.isArray(input)) return oneLine(input.join(' '), max);
  const picked = INPUT_KEYS.filter((k) => input[k] != null).map((k) => `${k}=${typeof input[k] === 'string' ? input[k] : JSON.stringify(input[k])}`);
  return oneLine(picked.length ? picked.join(', ') : JSON.stringify(input), max);
}

export function toTurns(session) {
  const turns = [];
  for (const m of session.messages) {
    if (m.role === 'user' || !turns.length) turns.push({ user: m.role === 'user' ? m : null, replies: [] });
    if (m.role === 'assistant') turns[turns.length - 1].replies.push(m);
  }
  return turns;
}

function renderTurn(turn, n, level) {
  const L = LIMITS[level];
  const out = [`### 第 ${n} 轮`];
  if (turn.user) out.push(`**用户：**\n\n${clip(turn.user.text, L.user)}`);
  const parts = turn.replies.flatMap((r) => r.parts);
  if (!parts.length) return out.join('\n\n');
  const lines = [];
  if (level === 2) {
    const tools = parts.filter((p) => p.type === 'tool');
    const texts = parts.filter((p) => p.type === 'text');
    if (tools.length) {
      const counts = {};
      for (const t of tools) counts[t.name] = (counts[t.name] || 0) + 1;
      lines.push(`_（调用工具 ${tools.length} 次：${Object.entries(counts).map(([k, v]) => `${k}×${v}`).join('、')}）_`);
    }
    if (texts.length) lines.push(clip(texts[texts.length - 1].text, L.text));
  } else {
    for (const p of parts) {
      if (p.type === 'text') { lines.push(clip(p.text, L.text)); continue; }
      const status = p.isError ? ' ❌' : '';
      lines.push(`- 🔧 \`${p.name}\` ${summarizeInput(p.input, L.input)}${status}`);
      if (L.output && p.output) lines.push(fence(clip(p.output, L.output)));
    }
  }
  out.push(`**助手：**\n\n${lines.join('\n\n')}`);
  return out.join('\n\n');
}

function lastAssistantText(turns) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const texts = turns[i].replies.flatMap((r) => r.parts).filter((p) => p.type === 'text');
    if (texts.length) return texts[texts.length - 1].text;
  }
  return '';
}

function lastUserText(turns) {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].user) return turns[i].user.text;
  return '';
}

function header(session, label, stats) {
  const rows = [
    ['来源', label],
    ['会话 ID', `\`${session.id}\``],
    ['工作目录', session.cwd ? `\`${session.cwd}\`` : '未知'],
    session.model && ['模型', session.model],
    ['时间', [session.createdAt, session.updatedAt].filter(Boolean).join(' → ') || '未知'],
    stats && ['规模', stats],
  ].filter(Boolean);
  return [
    `# 会话交接：${session.title || '(无标题)'}`,
    [
      `> 下面是用户之前在 **${label}** 里进行的一段编程会话，现在由你接手继续。请把它当作你和用户之前的对话：`,
      '> - 记录里的工具调用是之前那个助手执行的，文件可能已被修改，请以磁盘当前状态为准，需要时重新读取文件。',
      '> - 不要重复已经完成的工作；对下一步不确定时先向用户确认。',
    ].join('\n'),
    '| 项 | 值 |\n| --- | --- |\n' + rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`).join('\n'),
  ].join('\n\n');
}

export function renderHandoff(session, label, { maxChars = 120000, recent = 6 } = {}) {
  if (session.rawMarkdown) {
    const body = session.rawMarkdown.length > maxChars
      ? '…[较早的内容已省略]\n\n' + session.rawMarkdown.slice(-maxChars)
      : session.rawMarkdown;
    return `${header(session, label)}\n\n## 对话记录（官方导出）\n\n${body}\n`;
  }

  const turns = toTurns(session);
  const n = turns.length;
  const levels = turns.map((_, i) => (i >= n - recent ? 0 : 1));
  const dropped = new Set();
  const cache = new Map();
  const size = (i) => {
    const key = `${i}:${levels[i]}`;
    if (!cache.has(key)) cache.set(key, renderTurn(turns[i], i + 1, levels[i]).length);
    return cache.get(key);
  };
  const total = () => turns.reduce((sum, _, i) => sum + (dropped.has(i) ? 0 : size(i)), 0);

  // Tool output can be re-read from disk by the next agent; the user's earlier
  // requests cannot. So shrink detail first (oldest first), and drop whole
  // turns only as a last resort, always keeping the first and last turns.
  const passes = [
    (i) => levels[i] === 1 && (levels[i] = 2),
    (i) => levels[i] === 0 && i < n - 1 && (levels[i] = 1),
    (i) => levels[i] === 1 && i < n - 1 && (levels[i] = 2),
    (i) => i > 0 && i < n - 1 && !dropped.has(i) && dropped.add(i),
    (i) => levels[i] === 0 && (levels[i] = 1),
  ];
  for (const pass of passes) {
    for (let i = 0; i < n && total() > maxChars; i++) pass(i);
  }

  const body = [];
  let gap = 0;
  turns.forEach((t, i) => {
    if (dropped.has(i)) { gap++; return; }
    if (gap) { body.push(`_…此处省略了 ${gap} 轮较早的对话…_`); gap = 0; }
    body.push(renderTurn(t, i + 1, levels[i]));
  });

  const compressed = levels.filter((l) => l > 0).length;
  const stats = `${n} 轮对话` + (compressed || dropped.size ? `（${compressed} 轮已压缩，${dropped.size} 轮已省略）` : '');
  const status = [
    '## 当前进度',
    `**用户最后的请求：**\n\n${clip(lastUserText(turns), 3000) || '（无）'}`,
    `**助手最后的回复：**\n\n${clip(lastAssistantText(turns), 3000) || '（无）'}`,
  ].join('\n\n');
  return `${header(session, label, stats)}\n\n${status}\n\n## 对话记录\n\n${body.join('\n\n---\n\n')}\n`;
}
