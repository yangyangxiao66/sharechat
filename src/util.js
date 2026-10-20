import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

export const HOME = os.homedir();

// Read a text file, transparently decompressing .zst (Codex compressed rollouts).
export function readText(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') {
      throw new Error(`读取 ${path.basename(file)} 需要 Node.js >= 22.15（zstd 支持）`);
    }
    return zlib.zstdDecompressSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

// Run another agent's CLI and capture stdout. Returns null when it is missing or fails.
export function runCli(cmd, args, { timeout = 60000, cwd } = {}) {
  const win = process.platform === 'win32';
  const r = spawnSync(cmd, win ? args.map(quoteArg) : args, {
    encoding: 'utf8',
    timeout,
    cwd,
    maxBuffer: 512 * 1024 * 1024,
    shell: win,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

export function quoteArg(a) {
  a = String(a);
  if (process.platform === 'win32') return `"${a.replace(/"/g, "'")}"`;
  return `'${a.replace(/'/g, `'\\''`)}'`;
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial or corrupt line */ }
  }
  return out;
}

export function readJsonl(file) {
  return parseJsonl(readText(file));
}

// Parse only the first maxBytes of a JSONL file; cheap metadata for listing.
export function headJsonl(file, maxBytes = 256 * 1024) {
  if (file.endsWith('.zst')) return readJsonl(file);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return parseJsonl(buf.subarray(0, n).toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

export function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

export function walkFiles(dir, pred, maxDepth = 6) {
  const out = [];
  const rec = (d, depth) => {
    for (const e of listDir(d)) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < maxDepth) rec(p, depth + 1); }
      else if (pred(e.name, p)) out.push(p);
    }
  };
  rec(dir, 0);
  return out;
}

export function mtime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch { return null; }
}

export function clip(s, n) {
  if (s == null) return '';
  s = String(s);
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[已截断，原长 ${s.length} 字符]`;
}

export function oneLine(s, n = 120) {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('\n');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (typeof v.output === 'string') return v.output;
    if (typeof v.content === 'string' || Array.isArray(v.content)) return toText(v.content);
    if (v.type === 'image' || v.type === 'input_image') return '[图片]';
    return JSON.stringify(v);
  }
  return String(v);
}

export function tryParse(s) {
  if (typeof s !== 'string') return s;
  try { return JSON.parse(s); } catch { return s; }
}

// Remove injected harness blocks such as <system-reminder>...</system-reminder>.
export function stripBlocks(text, tags) {
  let t = text;
  for (const tag of tags) {
    t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'g'), '');
  }
  return t.trim();
}

export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => {
    let r = path.resolve(p).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}
