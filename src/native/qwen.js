// Write a native Qwen Code session (ChatRecord JSONL) so `qwen --resume <id>`
// restores it. Location and checks follow
// packages/core/src/services/sessionService.ts: the file must be
// ~/.qwen/projects/<sanitizeCwd>/chats/<uuid>.jsonl and the first record's cwd
// must hash to the project being resumed.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home } from '../adapters/qwen.js';
import { flatten, timeline } from './flatten.js';
import { historyBudget } from './budget.js';

export function sanitizeCwd(cwd) {
  const p = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

export function writeQwenSession(session, sourceLabel, { cwd, maxTokens }) {
  const msgs = flatten(session, sourceLabel, { maxTokens: maxTokens ?? historyBudget('qwen') });
  const times = timeline(msgs);
  const sessionId = randomUUID();
  let parentUuid = null;
  const records = msgs.map((m, i) => {
    const uuid = randomUUID();
    const rec = {
      uuid, parentUuid, sessionId,
      timestamp: times[i].toISOString(),
      type: m.role === 'user' ? 'user' : 'assistant',
      cwd, version: 'sharechat',
      message: { role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] },
    };
    parentUuid = uuid;
    return rec;
  });
  if (session.title) {
    records.push({
      uuid: randomUUID(), parentUuid, sessionId, timestamp: new Date().toISOString(),
      type: 'system', subtype: 'custom_title', cwd, version: 'sharechat',
      systemPayload: { customTitle: `${session.title}（来自 ${sourceLabel}）`, titleSource: 'manual' },
    });
  }
  const dir = path.join(home(), 'projects', sanitizeCwd(cwd), 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { sessionId, file, resume: { cmd: 'qwen', args: ['--resume', sessionId] } };
}
