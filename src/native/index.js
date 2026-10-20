import { writeClaudeSession } from './claude.js';
import { writeCodexSession } from './codex.js';
import { writeQwenSession } from './qwen.js';
import { writeGeminiSession } from './gemini.js';
import { writeOpencodeSession } from './opencode.js';
import { writeGrokSession } from './grok.js';
import { writeCursorSession } from './cursor.js';

// Targets that can open an imported session as real history via --resume.
export const NATIVE = {
  claude: writeClaudeSession,
  codex: writeCodexSession,
  qwen: writeQwenSession,
  gemini: writeGeminiSession,
  opencode: writeOpencodeSession,
  grok: writeGrokSession,
  cursor: writeCursorSession,
};
