// Import a session into OpenCode through its official `opencode import <file>`
// command, using the `opencode export` JSON shape
// ({ info, messages: [{ info, parts }] }, MessageV2 in
// packages/opencode/src/session/message-v2.ts), which both v1.1 and v1.19
// accept. IDs follow packages/opencode/src/id/id.ts: sessions sort
// descending, messages and parts ascending.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { runCli } from '../util.js';
import { flatten, timeline } from './flatten.js';
import * as reader from '../adapters/opencode.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastMs = 0, counter = 0;
export function opencodeId(prefix, ms, descending = false) {
  if (ms !== lastMs) { lastMs = ms; counter = 0; }
  let n = BigInt(ms) * 0x1000n + BigInt(++counter);
  if (descending) n = ~n;
  let hex = '';
  for (let i = 0; i < 6; i++) hex += Number((n >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0');
  const rnd = [...randomBytes(14)].map((b) => B62[b % 62]).join('');
  return `${prefix}_${hex}${rnd}`;
}

// packages/opencode/src/project/project.ts: git root commit, else "global".
function projectId(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const git = path.join(dir, '.git');
    if (fs.existsSync(git)) {
      try { return fs.readFileSync(path.join(git, 'opencode'), 'utf8').trim(); } catch { /* not cached */ }
      const roots = runCli('git', ['-C', dir, 'rev-list', '--max-parents=0', '--all']);
      const first = roots?.split(/\r?\n/).filter(Boolean).sort()[0];
      return first || 'global';
    }
    const up = path.dirname(dir);
    if (up === dir) return 'global';
    dir = up;
  }
}

// The resumed session continues on the model recorded in its last user
// message, so it must be one `opencode models` currently offers. Prefer the
// model of the user's most recent OpenCode session when still available.
function pickModel(preferred) {
  const available = (runCli('opencode', ['models'], { timeout: 120000 }) || '')
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[^\s/]+\/\S+$/.test(l));
  const split = (s) => ({ providerID: s.slice(0, s.indexOf('/')), modelID: s.slice(s.indexOf('/') + 1) });
  if (preferred) return split(preferred);
  try {
    const latest = reader.list().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const out = latest && runCli('opencode', ['export', latest.id], { timeout: 120000, cwd: latest.cwd && fs.existsSync(latest.cwd) ? latest.cwd : os.homedir() });
    const data = out && JSON.parse(out.slice(out.indexOf('{')));
    const user = data && [...data.messages].reverse().find((m) => m.info?.role === 'user' && m.info.model);
    const recent = user && `${user.info.model.providerID}/${user.info.model.modelID}`;
    if (recent && available.includes(recent)) return split(recent);
  } catch { /* fall through */ }
  // Prefer a provider the user configured over OpenCode's shared free tier.
  const own = available.find((m) => !m.startsWith('opencode/'));
  return split(own || available[0] || 'opencode/big-pickle');
}

export function writeOpencodeSession(session, sourceLabel, { cwd, model: preferred }) {
  const msgs = flatten(session, sourceLabel);
  const times = timeline(msgs).map((d) => d.getTime());
  const model = pickModel(preferred);
  const now = Date.now();
  const sessionID = opencodeId('ses', now, true);
  const messages = [];
  let lastUser = null;
  msgs.forEach((m, i) => {
    const ms = times[i];
    const id = opencodeId('msg', ms);
    const info = m.role === 'user'
      ? { id, sessionID, role: 'user', time: { created: ms }, agent: 'build', model }
      : {
          id, sessionID, role: 'assistant', time: { created: ms, completed: ms },
          parentID: lastUser ?? id, modelID: model.modelID, providerID: model.providerID,
          mode: 'build', agent: 'build', path: { cwd, root: cwd }, cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop',
        };
    if (m.role === 'user') lastUser = id;
    messages.push({ info, parts: [{ id: opencodeId('prt', ms), sessionID, messageID: id, type: 'text', text: m.text }] });
  });
  const data = {
    info: {
      id: sessionID, slug: 'sharechat-import', version: '1.0.0', projectID: projectId(cwd), directory: cwd,
      title: `${session.title || '导入的会话'}（来自 ${sourceLabel}）`,
      time: { created: times[0] ?? now, updated: now },
    },
    messages,
  };

  const file = path.join(os.tmpdir(), `sharechat-opencode-${sessionID}.json`);
  fs.writeFileSync(file, JSON.stringify(data));
  const out = runCli('opencode', ['import', file], { timeout: 120000, cwd })
    ?? runCli('opencode', ['session', 'import', file], { timeout: 120000, cwd });
  fs.rmSync(file, { force: true });
  if (!out || !out.includes(sessionID)) throw new Error(`opencode import 失败：${(out || '').trim() || '未安装 opencode 或命令出错'}`);
  return { sessionId: sessionID, file: `opencode:${sessionID}`, resume: { cmd: 'opencode', args: ['--session', sessionID] } };
}
