// Shared operations behind both the CLI and the desktop app.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENTS, getAgent } from './agents.js';
import { NATIVE, selfResume, canSelfResume } from './native/index.js';
import { exists, samePath, quoteArg } from './util.js';

export function agentInfo() {
  return Object.values(AGENTS).map((a) => {
    const h = a.home();
    return {
      id: a.id,
      label: a.label,
      home: h,
      detected: h == null ? null : exists(h),
      canTarget: Boolean(NATIVE[a.id]),
      canSelfResume: canSelfResume(a.id),
      sourceOnly: Boolean(a.sourceOnly),
    };
  });
}

// List sessions newest first. Per-agent failures are reported, not thrown.
export function listSessions({ agents, cwd, onError } = {}) {
  const names = agents?.length ? agents : Object.keys(AGENTS);
  const all = [];
  for (const n of names) {
    try { all.push(...getAgent(n).list()); }
    catch (e) { onError?.(n, e); }
  }
  let rows = all.filter((s) => s.id);
  if (cwd) rows = rows.filter((s) => samePath(s.cwd, cwd));
  return rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

export function loadSession(meta) {
  const agent = getAgent(meta.agent);
  return { agent, session: agent.load(meta) };
}

// Convert a session into the target agent's native format.
export function convertSession(meta, targetId, { cwd, model } = {}) {
  const target = getAgent(targetId);
  const write = NATIVE[target.id];
  if (!write) throw new Error(`${target.label} 暂不支持原生写入`);
  const { agent: source, session } = loadSession(meta);
  const dir = path.resolve(cwd || (session.cwd && exists(session.cwd) ? session.cwd : process.cwd()));
  if (!fs.existsSync(dir)) throw new Error(`工作目录不存在：${dir}`);
  const r = write(session, source.label, { cwd: dir, model });
  return { ...r, cwd: dir, source: source.id, target: target.id, title: session.title, messages: session.messages.length };
}

// Reopen a session in the agent that created it — no conversion, no new file.
export function resumeNativeSession(meta) {
  const agent = getAgent(meta.agent);
  const cwd = typeof meta.cwd === 'string' ? meta.cwd : '';
  if (!cwd || !exists(cwd)) throw new Error(`工作目录不存在：${cwd || '(未知)'}`);
  const dir = path.resolve(cwd);
  const resume = selfResume(agent.id, meta, dir);
  if (!resume) throw new Error(`${agent.label} 暂不支持原生续聊`);
  const result = { cwd: dir, source: agent.id, target: agent.id, title: meta.title, sessionId: meta.id, native: true };
  if (resume.url) result.openUrl = resume.url;
  else result.resume = resume;
  return result;
}

// Human-readable command: quote only arguments that need it.
export function commandLine({ cmd, args }) {
  return [cmd, ...args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : quoteArg(a)))].join(' ');
}

// Open the resume command in a new terminal window (the agents are TUIs).
export function openInTerminal(resume, cwd) {
  const line = commandLine(resume);
  const opts = { cwd, detached: true, stdio: 'ignore' };
  if (process.platform === 'win32') {
    const wt = spawn('where', ['wt'], { shell: true }).on('exit', (code) => {
      if (code === 0) spawn('wt', ['-d', `"${cwd}"`, 'cmd', '/k', line], { ...opts, shell: true }).unref();
      else spawn('cmd', ['/c', 'start', '""', '/D', `"${cwd}"`, 'cmd', '/k', line], { ...opts, shell: true }).unref();
    });
    wt.unref();
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script ${JSON.stringify(`cd ${quoteArg(cwd)} && ${line}`)}\ntell application "Terminal" to activate`;
    spawn('osascript', ['-e', script], opts).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', 'sh', '-c', `cd ${quoteArg(cwd)} && ${line}; exec $SHELL`], opts).unref();
  }
  return line;
}
