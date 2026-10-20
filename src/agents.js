import * as claude from './adapters/claude.js';
import * as codex from './adapters/codex.js';
import * as gemini from './adapters/gemini.js';
import * as qwen from './adapters/qwen.js';
import * as opencode from './adapters/opencode.js';
import * as grok from './adapters/grok.js';

export const AGENTS = { claude, codex, grok, qwen, gemini, opencode };

export function getAgent(name) {
  const a = AGENTS[String(name).toLowerCase()];
  if (!a) throw new Error(`未知的 agent: ${name}（可选：${Object.keys(AGENTS).join(', ')}）`);
  return a;
}
