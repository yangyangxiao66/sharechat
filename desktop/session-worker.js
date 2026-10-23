import { parentPort, workerData } from 'node:worker_threads';
import { agentInfo, listSessions, loadSession, convertSession, resumeNativeSession } from '../src/core.js';
import { summarizeInput } from '../src/render.js';
import { clip, runCli } from '../src/util.js';

// Keep filesystem scans, JSON parsing and external CLI exports off Electron's
// main thread so embedded PTY input/output stays responsive.
function preview(session) {
  const start = Math.max(0, session.messages.length - 400);
  return {
    ...session, total: session.messages.length, omitted: start,
    messages: session.messages.slice(start).map(message => message.role === 'user'
      ? { role: 'user', text: clip(message.text, 6000), ts: message.ts }
      : { role: 'assistant', ts: message.ts, parts: message.parts.map(part => part.type === 'text'
        ? { type: 'text', text: clip(part.text, 6000) }
        : { type: 'tool', name: part.name, input: summarizeInput(part.input, 240),
          output: clip(part.output ?? '', 2000), isError: part.isError }) }),
    rawMarkdown: session.rawMarkdown ? clip(session.rawMarkdown, 60000) : undefined,
  };
}

try {
  const { operation, args = {} } = workerData;
  let data;
  if (operation === 'agents') data = agentInfo();
  else if (operation === 'sessions') {
    const errors = [];
    const rows = listSessions({ onError: (agent, error) => errors.push({ agent, message: error.message }) });
    data = { rows, errors };
  } else if (operation === 'load') data = preview(loadSession(args.meta).session);
  else if (operation === 'convert') data = convertSession(args.meta, args.target, { model: args.model || undefined });
  else if (operation === 'resume') data = resumeNativeSession(args.meta);
  else if (operation === 'models') data = (runCli('opencode', ['models'], { timeout: 120000 }) || '')
    .split(/\r?\n/).map(line => line.trim()).filter(line => /^[^\s/]+\/\S+$/.test(line));
  else throw new Error('未知会话操作');
  parentPort.postMessage({ ok: true, data });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message || String(error) });
}
