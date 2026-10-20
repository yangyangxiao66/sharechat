// Write a native Gemini CLI session so `gemini --resume <id>` restores it.
// Project folders under ~/.gemini/tmp are resolved through projects.json; a
// folder whose .project_root marker names the project is adopted on startup
// (packages/core/src/config/projectRegistry.ts, findExistingSlugForPath).
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { home } from '../adapters/gemini.js';
import { readJson } from '../util.js';
import { flatten, timeline } from './flatten.js';

const normalize = (p) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function projectDir(cwd) {
  const tmp = path.join(home(), 'tmp');
  const registered = readJson(path.join(home(), 'projects.json'))?.projects?.[normalize(cwd)];
  if (registered) return path.join(tmp, registered);
  try {
    for (const d of fs.readdirSync(tmp, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      try {
        const owner = fs.readFileSync(path.join(tmp, d.name, '.project_root'), 'utf8').trim();
        if (normalize(owner) === normalize(cwd)) return path.join(tmp, d.name);
      } catch { /* no marker */ }
    }
  } catch { /* no tmp dir yet */ }
  const base = path.basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'project';
  let slug = base, n = 1;
  while (fs.existsSync(path.join(tmp, slug))) slug = `${base}-${++n}`;
  const dir = path.join(tmp, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.project_root'), path.resolve(cwd));
  return dir;
}

export function writeGeminiSession(session, sourceLabel, { cwd }) {
  const msgs = flatten(session, sourceLabel);
  const times = timeline(msgs);
  const sessionId = randomUUID();
  const now = new Date();
  const lines = [{
    // projectHash must be non-empty or Gemini treats the file as corrupt and
    // its session cleanup deletes it (packages/core/src/utils/paths.ts).
    sessionId, projectHash: createHash('sha256').update(path.resolve(cwd)).digest('hex'), startTime: times[0].toISOString(), lastUpdated: now.toISOString(),
    summary: session.title ? `${session.title}（来自 ${sourceLabel}）` : undefined, kind: 'main',
  }];
  msgs.forEach((m, i) => lines.push({
    id: randomUUID(), timestamp: times[i].toISOString(),
    type: m.role === 'user' ? 'user' : 'gemini',
    content: [{ text: m.text }],
  }));
  const dir = path.join(projectDir(cwd), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().slice(0, 16).replace(/:/g, '-');
  const file = path.join(dir, `session-${stamp}-${sessionId.slice(0, 8)}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { sessionId, file, resume: { cmd: 'gemini', args: ['--resume', sessionId] } };
}
