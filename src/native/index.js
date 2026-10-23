import { writeClaudeSession } from './claude.js';
import { writeCodexSession, writeChatGptSession } from './codex.js';
import { writeQwenSession } from './qwen.js';
import { writeGeminiSession } from './gemini.js';
import { writeOpencodeSession } from './opencode.js';
import { writeGrokSession } from './grok.js';
import { writeCursorSession } from './cursor.js';
import { writeWorkBuddySession } from './workbuddy.js';
import { writeQoderSession } from './qoder.js';

// Targets that can open an imported session as real history via --resume.
export const NATIVE = {
  claude: writeClaudeSession,
  codex: writeCodexSession,
  chatgpt: writeChatGptSession,
  qwen: writeQwenSession,
  gemini: writeGeminiSession,
  opencode: writeOpencodeSession,
  grok: writeGrokSession,
  cursor: writeCursorSession,
  workbuddy: writeWorkBuddySession,
  qoder: writeQoderSession,
};

// Resume a session that is already in the agent's own native format.
const SELF_RESUME = {
  claude: (meta) => ({ cmd: 'claude', args: ['--resume', meta.id] }),
  codex: (meta) => ({ cmd: 'codex', args: ['resume', meta.id] }),
  qwen: (meta) => ({ cmd: 'qwen', args: ['--resume', meta.id] }),
  gemini: (meta) => ({ cmd: 'gemini', args: ['--resume', meta.id] }),
  opencode: (meta) => ({ cmd: 'opencode', args: ['--session', meta.id] }),
  grok: (meta) => ({ cmd: 'grok', args: ['--resume', meta.id] }),
  cursor: (_meta, cwd) => ({ cmd: 'cursor', args: [cwd] }),
  chatgpt: (meta) => ({ url: `codex://threads/${encodeURIComponent(meta.id)}` }),
};

export function selfResume(agentId, meta, cwd) {
  const id = String(agentId).toLowerCase();
  const build = SELF_RESUME[id];
  if (!build) return null;
  if (id === 'cursor' ? !cwd : typeof meta.id !== 'string' || !meta.id) return null;
  return build(meta, cwd);
}

export function canSelfResume(agentId) {
  return Boolean(SELF_RESUME[String(agentId).toLowerCase()]);
}
