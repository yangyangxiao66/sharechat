// Token budget for an imported history, from the target's model context
// window. Agents compact by sending the whole history to the model, so it must
// fit with room for the summary prompt and output (see flatten.js).
import fs from 'node:fs';
import path from 'node:path';
import { HOME, readJson } from '../util.js';
import { DEFAULT_MAX_TOKENS } from './flatten.js';

// Assumed when an agent can be pointed at third-party models of unknown size.
const SMALL_CONTEXT = 128000;

export function budgetFromContext(context, output = 32000) {
  if (!context) return DEFAULT_MAX_TOKENS;
  return Math.max(8000, Math.floor((context - Math.min(output || 0, 32000)) * 0.6));
}

// Top-level `key = value` of a TOML file (before the first [table]).
function tomlTop(file, key) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const top = text.split(/^\s*\[/m)[0];
  const m = new RegExp(`^\\s*${key}\\s*=\\s*("([^"]*)"|'([^']*)'|(\\d+))`, 'm').exec(top);
  return m ? (m[2] ?? m[3] ?? Number(m[4])) : null;
}

// Codex: `model_context_window` in config.toml, else the models cache the CLI
// refreshes from the server (context_window × effective_context_window_percent).
function codexContext() {
  const root = process.env.CODEX_HOME || path.join(HOME, '.codex');
  const config = path.join(root, 'config.toml');
  const explicit = tomlTop(config, 'model_context_window');
  if (explicit) return explicit;
  const model = tomlTop(config, 'model');
  const m = readJson(path.join(root, 'models_cache.json'))?.models?.find((x) => x.slug === model);
  return m?.context_window ? Math.floor(m.context_window * (m.effective_context_window_percent ?? 100) / 100) : null;
}

// Grok: the CLI's models cache, for the default model in config.toml.
function grokContext() {
  const root = process.env.GROK_HOME || path.join(HOME, '.grok');
  let model = null;
  try { model = /^\s*default\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(path.join(root, 'config.toml'), 'utf8').split(/^\s*\[models\]/m)[1] || '')?.[1]; } catch { /* no config */ }
  const models = Object.values(readJson(path.join(root, 'models_cache.json'))?.models || {});
  const info = (models.find((x) => x.info?.id === model) || models[0])?.info;
  return info?.context_window ?? null;
}

// Claude Code: 200k, 1M for `[1m]` models. A non-Anthropic ANTHROPIC_BASE_URL
// means a third-party model whose window is unknown.
function claudeContext() {
  const settings = readJson(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'settings.json')) || {};
  const env = { ...settings.env, ...process.env };
  const base = env.ANTHROPIC_BASE_URL;
  if (base && !/anthropic\.com/i.test(base)) return SMALL_CONTEXT;
  const model = env.ANTHROPIC_MODEL || settings.model || '';
  return /\[1m\]/i.test(model) ? 1000000 : 200000;
}

// Qwen Code: the qwen3-coder models have 1M; it also runs any
// OpenAI-compatible model, so assume a small window otherwise.
function qwenContext() {
  const settings = readJson(path.join(process.env.QWEN_HOME || path.join(HOME, '.qwen'), 'settings.json')) || {};
  const model = process.env.OPENAI_MODEL || settings.model?.name || (typeof settings.model === 'string' ? settings.model : '');
  return !model || /^qwen3-coder/i.test(model) ? 1000000 : SMALL_CONTEXT;
}

const CONTEXT = {
  claude: claudeContext,
  codex: codexContext,
  grok: grokContext,
  qwen: qwenContext,
  gemini: () => 1048576,
  cursor: () => 200000,
};

export function historyBudget(agentId) {
  try { return budgetFromContext(CONTEXT[agentId]?.()); } catch { return DEFAULT_MAX_TOKENS; }
}
