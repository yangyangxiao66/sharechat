import * as claude from './adapters/claude.js';
import * as codex from './adapters/codex.js';
import * as chatgpt from './adapters/chatgpt.js';
import * as gemini from './adapters/gemini.js';
import * as qwen from './adapters/qwen.js';
import * as opencode from './adapters/opencode.js';
import * as qoder from './adapters/qoder.js';
import * as grok from './adapters/grok.js';
import * as cursor from './adapters/cursor.js';
import * as workbuddy from './adapters/workbuddy.js';

export const AGENTS = { claude, codex, chatgpt, cursor, workbuddy, grok, qwen, gemini, opencode, qoder };

export function getAgent(name) {
  const a = AGENTS[String(name).toLowerCase()];
  if (!a) throw new Error(`未知的 agent: ${name}（可选：${Object.keys(AGENTS).join(', ')}）`);
  return a;
}
