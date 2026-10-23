import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-test-'));
const write = (rel, lines) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Array.isArray(lines) ? lines.map((l) => JSON.stringify(l)).join('\n') + '\n' : lines);
  return p;
};

let AGENTS, renderHandoff, NATIVE;
before(async () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.CODEX_HOME = path.join(tmp, 'codex');
  process.env.GROK_HOME = path.join(tmp, 'grok');
  process.env.QWEN_HOME = path.join(tmp, 'qwen');
  process.env.GEMINI_CLI_HOME = path.join(tmp, 'gem');
  ({ AGENTS } = await import('../src/agents.js'));
  ({ renderHandoff } = await import('../src/render.js'));
  ({ NATIVE } = await import('../src/native/index.js'));
});

const flat = (s) => s.messages.map((m) => (m.role === 'user' ? `U:${m.text}` : 'A:' + m.parts.map((p) => (p.type === 'text' ? p.text : `[${p.name}=>${p.output}]`)).join('|')));

test('claude: follows active branch and pairs tool results', () => {
  const base = { sessionId: 's1', cwd: '/proj', isSidechain: false };
  write('claude/projects/-proj/s1.jsonl', [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'fix bug<system-reminder>noise</system-reminder>' } },
    { ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { ...base, type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.js' }] } },
    { ...base, type: 'assistant', uuid: 'dead', parentUuid: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'abandoned branch' }] } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'r1', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  ]);
  const [meta] = AGENTS.claude.list();
  assert.equal(meta.cwd, '/proj');
  const s = AGENTS.claude.load(meta);
  assert.deepEqual(flat(s), ['U:fix bug', 'A:looking|[Bash=>a.js]|done']);
  assert.equal(s.model, 'claude-x');
});

test('codex: skips injected context, extracts request, pairs call outputs', () => {
  write('codex/sessions/2026/10/01/rollout-2026-10-01T00-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl', [
    { type: 'session_meta', payload: { id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', cwd: '/c', timestamp: '2026-10-01T00:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context><cwd>/c</cwd></environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# Files\n## My request for Codex:\nadd tests' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'x.rs' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } },
  ]);
  write('codex/session_index.jsonl', [{ id: '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee', thread_name: 'Add tests' }]);
  const [meta] = AGENTS.codex.list();
  assert.equal(meta.title, 'Add tests');
  assert.deepEqual(flat(AGENTS.codex.load(meta)), ['U:add tests', 'A:[shell=>x.rs]|ok']);
});

test('chatgpt desktop: separate source from Codex CLI sessions', () => {
  const sid = '0199dddd-1111-7222-8333-444444444444';
  write(`codex/sessions/2026/10/02/rollout-2026-10-02T00-00-00-${sid}.jsonl`, [
    { type: 'session_meta', payload: { id: sid, cwd: '/desk', originator: 'Codex Desktop', source: 'vscode', thread_source: 'user', timestamp: '2026-10-02T00:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'desktop hello' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] } },
  ]);
  const meta = AGENTS.chatgpt.list().find((m) => m.id === sid);
  assert.ok(meta, 'ChatGPT desktop source should list its thread');
  assert.equal(meta.agent, 'chatgpt');
  assert.equal(AGENTS.codex.list().some((m) => m.id === sid), false);
  const s = AGENTS.chatgpt.load(meta);
  assert.equal(s.agent, 'chatgpt');
  assert.deepEqual(flat(s), ['U:desktop hello', 'A:hi']);
});

test('grok: extracts user_query and tool results', () => {
  write('grok/sessions/%2Fg/01aa/summary.json', JSON.stringify({ info: { id: '01aa', cwd: '/g' }, generated_title: 'T' }));
  write('grok/sessions/%2Fg/01aa/chat_history.jsonl', [
    { type: 'system', content: 'sys' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>os</user_info>' }] },
    { type: 'user', content: [{ type: 'text', text: '<user_query>\nslow down\n</user_query>' }] },
    { type: 'assistant', content: 'checking', tool_calls: [{ id: 'k1', name: 'grep', arguments: '{"pattern":"x"}' }] },
    { type: 'tool_result', tool_call_id: 'k1', content: 'hit' },
    { type: 'assistant', content: 'fixed' },
  ]);
  const [meta] = AGENTS.grok.list();
  assert.equal(meta.cwd, '/g');
  assert.deepEqual(flat(AGENTS.grok.load(meta)), ['U:slow down', 'A:checking|[grep=>hit]|fixed']);
});

test('qwen: ChatRecord chain with functionCall/functionResponse', () => {
  const b = { sessionId: 'q1', cwd: '/q', version: '1' };
  write('qwen/projects/-q/chats/q1.jsonl', [
    { ...b, uuid: '1', parentUuid: null, type: 'user', message: { role: 'user', parts: [{ text: 'hello' }] } },
    { ...b, uuid: '2', parentUuid: '1', type: 'assistant', model: 'qwen3', message: { role: 'model', parts: [{ text: 'thinking', thought: true }, { functionCall: { id: 'f1', name: 'read_file', args: { path: 'a' } } }] } },
    { ...b, uuid: '3', parentUuid: '2', type: 'tool_result', message: { role: 'user', parts: [{ functionResponse: { id: 'f1', name: 'read_file', response: { output: 'content' } } }] } },
    { ...b, uuid: '4', parentUuid: '3', type: 'system', subtype: 'custom_title', systemPayload: { customTitle: 'Greeting' } },
    { ...b, uuid: '5', parentUuid: '4', type: 'assistant', message: { role: 'model', parts: [{ text: 'hi' }] } },
  ]);
  const [meta] = AGENTS.qwen.list();
  assert.equal(meta.title, 'Greeting');
  const s = AGENTS.qwen.load(meta);
  assert.deepEqual(flat(s), ['U:hello', 'A:[read_file=>content]|hi']);
  assert.equal(s.model, 'qwen3');
});

test('gemini: replays $rewindTo / $patch log', () => {
  write('gem/.gemini/tmp/proj/.project_root', '/gm');
  write('gem/.gemini/tmp/proj/chats/session-2026-x.jsonl', [
    { sessionId: 'g1', projectHash: 'h', startTime: '2026-01-01T00:00:00Z' },
    { id: 'm1', type: 'user', content: [{ text: 'first try' }], timestamp: 't' },
    { $rewindTo: 'm1' },
    { id: 'm2', type: 'user', content: [{ text: 'second try' }], timestamp: 't' },
    { id: 'm3', type: 'gemini', content: [{ text: 'answer' }], toolCalls: [{ id: 'tc', name: 'ls', args: {}, status: 'success' }], timestamp: 't' },
    { $patch: { id: 'm3', toolCalls: [{ id: 'tc', result: [{ functionResponse: { response: { output: 'files' } } }] }] } },
  ]);
  const [meta] = AGENTS.gemini.list();
  assert.equal(meta.cwd, '/gm');
  assert.deepEqual(flat(AGENTS.gemini.load(meta)), ['U:second try', 'A:answer|[ls=>files]']);
});

test('render: stays within budget and keeps first and last turns', () => {
  const s = { agent: 'x', id: 'id', title: 't', cwd: '/', messages: [] };
  for (let i = 0; i < 200; i++) {
    s.messages.push({ role: 'user', text: `request ${i} ` + 'x'.repeat(500) });
    s.messages.push({ role: 'assistant', parts: [{ type: 'text', text: 'y'.repeat(3000) }, { type: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'z'.repeat(5000) }] });
  }
  const md = renderHandoff(s, 'X', { maxChars: 50000 });
  assert.ok(md.length < 60000, `length ${md.length}`);
  assert.match(md, /request 0 /);
  assert.match(md, /request 199 /);
});

const sample = () => ({ agent: 'codex', id: 'abc', title: 'T', cwd: '/w', messages: [
  { role: 'assistant', parts: [{ type: 'text', text: 'orphan reply' }] },
  { role: 'user', text: 'q1' },
  { role: 'assistant', parts: [{ type: 'tool', name: 'ls', input: 'ls', output: 'a.txt' }, { type: 'text', text: 'done' }] },
  { role: 'user', text: 'q2' },
  { role: 'assistant', parts: [{ type: 'text', text: 'second' }] },
] });

// Write natively, then read back through that agent's own adapter.
for (const target of ['claude', 'codex', 'qwen', 'gemini', 'grok']) {
  test(`native ${target}: round-trips through its own reader`, () => {
    const cwd = path.join(tmp, 'proj-' + target);
    fs.mkdirSync(cwd, { recursive: true });
    const r = NATIVE[target](sample(), 'Codex', { cwd });
    assert.ok(fs.existsSync(r.file));
    assert.ok(r.resume.args.includes(r.sessionId));
    if (target === 'gemini') {
      // Gemini deletes session files whose metadata lacks a projectHash.
      const head = JSON.parse(fs.readFileSync(r.file, 'utf8').split('\n')[0]);
      assert.match(head.projectHash, /^[0-9a-f]{64}$/);
    }
    const meta = AGENTS[target].list().find((m) => m.id === r.sessionId);
    assert.ok(meta, 'listed by its adapter');
    const s = AGENTS[target].load(meta);
    const texts = flat(s);
    assert.equal(texts.length, 6);
    assert.match(texts[0], /^U:\[本会话由 sharechat 从 Codex 导入/);
    assert.equal(texts[1], 'A:orphan reply');
    assert.match(texts[2], /q1$/);
    assert.match(texts[3], /external_agent_tool_call: ls[\s\S]*a\.txt[\s\S]*done/);
    assert.equal(texts[4], 'U:q2');
    assert.equal(texts[5], 'A:second');
  });
}

test('native chatgpt: writes a Codex Desktop thread and opens via deep link', () => {
  write('codex/config.toml', ['model_provider = "custom"', 'model = "gpt-test"'].join('\n'));
  const cwd = path.join(tmp, 'proj-chatgpt');
  fs.mkdirSync(cwd, { recursive: true });
  const r = NATIVE.chatgpt(sample(), 'WorkBuddy', { cwd });
  assert.ok(fs.existsSync(r.file));
  assert.equal(r.resume, undefined);
  assert.equal(r.openUrl, `codex://threads/${r.sessionId}`);
  const events = fs.readFileSync(r.file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const head = events[0].payload;
  assert.equal(head.originator, 'Codex Desktop');
  assert.equal(head.source, 'vscode');
  assert.equal(head.thread_source, 'user');
  assert.equal(head.history_mode, 'paginated');
  assert.equal(head.model_provider, 'custom');
  const completed = events.filter((e) => e.type === 'event_msg' && e.payload?.type === 'item_completed');
  assert.equal(completed.length, 6);
  assert.ok(completed.some((e) => e.payload.item.type === 'UserMessage'));
  assert.ok(completed.some((e) => e.payload.item.type === 'AgentMessage'));
  const meta = AGENTS.chatgpt.list().find((m) => m.id === r.sessionId);
  assert.ok(meta, 'listed by the ChatGPT desktop source');
  assert.equal(AGENTS.codex.list().some((m) => m.id === r.sessionId), false);
  const s = AGENTS.chatgpt.load(meta);
  assert.equal(s.agent, 'chatgpt');
  assert.equal(flat(s).length, 6);
});

test('opencode ids: sessions sort newest first, messages oldest first', async () => {
  const { opencodeId } = await import('../src/native/opencode.js');
  const s1 = opencodeId('ses', 1000, true), s2 = opencodeId('ses', 2000, true);
  const m1 = opencodeId('msg', 1000), m2 = opencodeId('msg', 1000), m3 = opencodeId('msg', 2000);
  assert.ok(s2 < s1);
  assert.ok(m1 < m2 && m2 < m3);
  assert.match(m1, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
});

test('grok dirname: matches Rust urlencoding and hashed long-path form', async () => {
  const { encodeCwdDirname } = await import('../src/native/grok.js');
  const { blake3Hex } = await import('../src/native/blake3.js');
  assert.equal(blake3Hex(''), 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262');
  assert.equal(blake3Hex('abc'), '6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
  assert.equal(encodeCwdDirname(String.raw`G:\ai客服`).name, 'G%3A%5Cai%E5%AE%A2%E6%9C%8D');
  assert.equal(encodeCwdDirname('/p/a(b)!').name, '%2Fp%2Fa%28b%29%21');
  const long = encodeCwdDirname('/home/u/' + 'a'.repeat(300) + '/My Project');
  assert.equal(long.hashed, true);
  assert.match(long.name, /^my-project-[0-9a-f]{16}$/);
});
