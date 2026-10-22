// Write a native Claude Code transcript so `claude --resume <id>` restores it
// as real conversation history.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home } from '../adapters/claude.js';
import { flatten, timeline } from './flatten.js';
import { historyBudget } from './budget.js';

export function projectSlug(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

export function writeClaudeSession(session, sourceLabel, { cwd, maxTokens }) {
  const msgs = flatten(session, sourceLabel, { maxTokens: maxTokens ?? historyBudget('claude') });
  const times = timeline(msgs);
  const sessionId = randomUUID();
  const base = { isSidechain: false, userType: 'external', entrypoint: 'cli', cwd, sessionId, version: '2.0.0', gitBranch: '' };
  let parentUuid = null;
  // Claude Code sizes the context from the last assistant usage; an estimate
  // lets it auto-compact an oversized imported history on the next turn.
  const tokens = Math.ceil(msgs.reduce((n, m) => n + Buffer.byteLength(m.text), 0) / 4);
  const lastAssistant = msgs.map((m) => m.role).lastIndexOf('assistant');
  const lines = msgs.map((m, i) => {
    const uuid = randomUUID();
    const timestamp = times[i].toISOString();
    const rec = m.role === 'user'
      ? { parentUuid, ...base, type: 'user', message: { role: 'user', content: m.text }, uuid, timestamp }
      : {
          parentUuid, ...base, type: 'assistant', uuid, timestamp,
          message: {
            id: `msg_openchat_${i}`, type: 'message', role: 'assistant', model: '<synthetic>',
            content: [{ type: 'text', text: m.text }],
            stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: i === lastAssistant ? tokens : 0, output_tokens: 0 },
          },
        };
    parentUuid = uuid;
    return JSON.stringify(rec);
  });
  if (session.title) lines.unshift(JSON.stringify({ type: 'custom-title', customTitle: `${session.title}（来自 ${sourceLabel}）`, sessionId }));

  const dir = path.join(home(), 'projects', projectSlug(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return { sessionId, file, resume: { cmd: 'claude', args: ['--resume', sessionId] } };
}
