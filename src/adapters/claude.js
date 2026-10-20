// Claude Code: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl
// Each line is a record linked by uuid/parentUuid; compaction boundaries keep
// a logicalParentUuid back to the pre-compaction branch.
import path from 'node:path';
import { HOME, listDir, headJsonl, readJsonl, mtime, stripBlocks, toText } from '../util.js';
import { newSession, Builder } from '../session.js';

const root = () => process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const projectsDir = () => path.join(root(), 'projects');
const NOISE_TAGS = ['system-reminder', 'local-command-caveat', 'local-command-stdout', 'local-command-stderr'];

export const id = 'claude';
export const label = 'Claude Code';

export function home() { return root(); }

function sessionFiles() {
  const out = [];
  for (const d of listDir(projectsDir())) {
    if (!d.isDirectory()) continue;
    const dir = path.join(projectsDir(), d.name);
    for (const f of listDir(dir)) {
      if (f.isFile() && f.name.endsWith('.jsonl')) out.push(path.join(dir, f.name));
    }
  }
  return out;
}

function userText(content) {
  if (typeof content === 'string') {
    const cmd = content.match(/<command-name>([\s\S]*?)<\/command-name>/);
    if (cmd) {
      const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1] ?? '';
      return `${cmd[1].trim()} ${args.trim()}`.trim();
    }
    return stripBlocks(content, NOISE_TAGS);
  }
  return '';
}

export function list() {
  return sessionFiles().map((file) => {
    const head = headJsonl(file, 128 * 1024);
    let cwd = '', title = '', command = '', created = null;
    for (const r of head) {
      if (!cwd && r.cwd) cwd = r.cwd;
      if (!created && r.timestamp) created = r.timestamp;
      if ((r.type === 'summary' && r.summary) || r.type === 'custom-title' || r.type === 'ai-title') {
        title = r.summary || r.customTitle || r.title || title;
      }
      if (!title && r.type === 'user' && !r.isMeta && !r.isSidechain) {
        const c = r.message?.content;
        const t = typeof c === 'string' ? userText(c) : (c || []).filter((b) => b.type === 'text').map((b) => stripBlocks(b.text, NOISE_TAGS)).join(' ');
        if (t && !t.startsWith('/')) title = t;
        else if (t) command ||= t;
      }
    }
    title ||= command;
    return { agent: id, id: path.basename(file, '.jsonl'), file, cwd, title, createdAt: created, updatedAt: mtime(file) };
  }).filter((s) => s.cwd || s.title);
}

// Follow parentUuid from the newest message so rewound branches are dropped.
function activeChain(records) {
  const byId = new Map();
  for (const r of records) if (r.uuid) byId.set(r.uuid, r);
  let leaf = null;
  for (const r of records) {
    if ((r.type === 'user' || r.type === 'assistant') && !r.isSidechain && r.uuid) leaf = r;
  }
  if (!leaf) return [];
  const chain = [];
  const seen = new Set();
  for (let r = leaf; r && !seen.has(r.uuid); ) {
    seen.add(r.uuid);
    chain.push(r);
    const parent = r.parentUuid ?? r.logicalParentUuid;
    r = parent ? byId.get(parent) : null;
  }
  return chain.reverse();
}

export function load(meta) {
  const records = readJsonl(meta.file);
  const s = newSession(id, meta.id, { file: meta.file, cwd: meta.cwd, title: meta.title, updatedAt: meta.updatedAt });
  const b = new Builder(s);
  for (const r of activeChain(records)) {
    if (r.isSidechain) continue;
    if (!s.createdAt && r.timestamp) s.createdAt = r.timestamp;
    if (r.cwd) s.cwd = r.cwd;
    const msg = r.message;
    if (!msg) continue;
    if (r.type === 'user') {
      if (r.isMeta) continue;
      if (r.isCompactSummary) { b.user(`[上一段上下文的压缩摘要]\n${toText(msg.content)}`, r.timestamp); continue; }
      if (typeof msg.content === 'string') { b.user(userText(msg.content), r.timestamp); continue; }
      const texts = [];
      for (const blk of msg.content || []) {
        if (blk.type === 'tool_result') b.result(blk.tool_use_id, toText(blk.content), blk.is_error);
        else if (blk.type === 'text') texts.push(stripBlocks(blk.text, NOISE_TAGS));
        else if (blk.type === 'image') texts.push('[图片]');
      }
      b.user(texts.filter(Boolean).join('\n'), r.timestamp);
    } else if (r.type === 'assistant') {
      if (msg.model && msg.model !== '<synthetic>') s.model = msg.model;
      for (const blk of msg.content || []) {
        if (blk.type === 'text') b.text(blk.text, r.timestamp);
        else if (blk.type === 'tool_use' || blk.type === 'server_tool_use') b.tool(blk.id, blk.name, blk.input, r.timestamp);
      }
    }
  }
  return b.done();
}

export function launchCommand(prompt) {
  return { cmd: 'claude', args: [prompt] };
}
