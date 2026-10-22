import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flatten, estimateTokens } from '../src/native/flatten.js';

const big = 'x'.repeat(40000); // ~10k tokens
function session(turns) {
  const messages = [];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', text: `问题 ${i}` });
    messages.push({ role: 'assistant', parts: [
      { type: 'text', text: `回答 ${i}` },
      { type: 'tool', name: 'Bash', input: { command: 'cat big' }, output: big },
    ] });
  }
  return { id: 'sid', messages };
}
const tokens = (msgs) => msgs.reduce((n, m) => n + estimateTokens(m.text), 0);
const alternates = (msgs) => msgs.every((m, i) => m.role === (i % 2 ? 'assistant' : 'user'));

test('flatten keeps short sessions intact', () => {
  const msgs = flatten(session(2), 'X', { maxTokens: 100000 });
  assert.equal(msgs.length, 4);
  assert.ok(msgs[1].text.includes('[external_agent_tool_result]'));
});

test('flatten drops old tool outputs to fit the budget', () => {
  const msgs = flatten(session(20), 'X', { maxTokens: 20000 });
  assert.ok(tokens(msgs) <= 20000 * 1.05, `got ${tokens(msgs)}`);
  assert.ok(alternates(msgs));
  assert.ok(msgs[0].text.includes('问题 0'));
  assert.ok(msgs.at(-1).text.includes('回答 19'));
});

test('flatten omits oldest messages when briefs are not enough', () => {
  const s = session(40);
  for (const m of s.messages) if (m.role === 'user') m.text = '长'.repeat(3000);
  const msgs = flatten(s, 'X', { maxTokens: 15000 });
  assert.ok(tokens(msgs) <= 15000 * 1.05, `got ${tokens(msgs)}`);
  assert.ok(alternates(msgs));
  assert.match(msgs[0].text, /省略了 \d+ 条较早的消息/);
  assert.ok(msgs.at(-1).text.includes('回答 39'));
});

test('maxTokens 0 disables trimming', () => {
  const msgs = flatten(session(20), 'X', { maxTokens: 0 });
  assert.ok(tokens(msgs) > 20000, `got ${tokens(msgs)}`);
});

test('history budget follows each target model context', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { historyBudget, budgetFromContext } = await import('../src/native/budget.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-budget-'));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { CODEX_HOME: path.join(tmp, 'codex'), GROK_HOME: path.join(tmp, 'grok'), CLAUDE_CONFIG_DIR: path.join(tmp, 'claude') });
    delete process.env.ANTHROPIC_BASE_URL; delete process.env.ANTHROPIC_MODEL;
    put('codex/config.toml', 'model = "m1"\n[tui]\nmodel = "x"\n');
    put('codex/models_cache.json', JSON.stringify({ models: [{ slug: 'm1', context_window: 400000, effective_context_window_percent: 50 }] }));
    assert.equal(historyBudget('codex'), budgetFromContext(200000));
    put('codex/config.toml', 'model = "m1"\nmodel_context_window = 64000\n');
    assert.equal(historyBudget('codex'), budgetFromContext(64000));
    put('grok/config.toml', '[models]\ndefault = "g2"\n');
    put('grok/models_cache.json', JSON.stringify({ models: { g1: { info: { id: 'g1', context_window: 1 } }, g2: { info: { id: 'g2', context_window: 256000 } } } }));
    assert.equal(historyBudget('grok'), budgetFromContext(256000));
    put('claude/settings.json', JSON.stringify({ model: 'opus[1m]' }));
    assert.equal(historyBudget('claude'), budgetFromContext(1000000));
    put('claude/settings.json', JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' } }));
    assert.equal(historyBudget('claude'), budgetFromContext(128000));
  } finally {
    for (const k of ['CODEX_HOME', 'GROK_HOME', 'CLAUDE_CONFIG_DIR']) if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k];
  }
});
