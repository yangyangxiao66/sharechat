import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-workbuddy-adapter-'));
const home = path.join(tmp, '.workbuddy');
const sessionId = '01a16155-0000-7000-8000-000000000001';
const cwd = 'D:/projects/shroom';
const projectDir = path.join(home, 'projects', 'd-projects-shroom');
const file = path.join(projectDir, `${sessionId}.jsonl`);
process.env.WORKBUDDY_HOME = home;

function writeJsonl(rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

writeJsonl([
  { type: 'session-meta', id: 'meta-1', sessionId, timestamp: 1792634378924, meta: {} },
  {
    id: 'u1', timestamp: 1792634379000, type: 'message', role: 'user', sessionId, cwd,
    providerData: { startsNewUserRequest: true },
    content: [{ type: 'input_text', text: '<system-reminder><user_info>noise</user_info></system-reminder><user_query>start the editor</user_query>' }],
  },
  {
    id: 'a1', timestamp: 1792634380000, type: 'message', role: 'assistant', sessionId, cwd,
    providerData: { model: 'deepseek-v4.1-flash' },
    content: [{ type: 'output_text', text: 'checking the project' }],
  },
  {
    type: 'function_call', id: 'c1', timestamp: 1792634381000, sessionId, cwd,
    callId: 'call-1', name: 'Read', arguments: '{"path":"a.txt"}',
    providerData: { model: 'deepseek-v4.1-flash' },
  },
  {
    type: 'function_call_result', id: 'r1', timestamp: 1792634382000, sessionId, cwd,
    callId: 'call-1', name: 'Read', status: 'completed', output: { type: 'text', text: 'file contents' },
  },
  {
    id: 'u2', timestamp: 1792634383000, type: 'message', role: 'user', sessionId, cwd,
    content: [{ type: 'input_text', text: '<cb_summary><user_query>old request</user_query></cb_summary>' }],
  },
  {
    id: 'a2', timestamp: 1792634384000, type: 'message', role: 'assistant', sessionId, cwd,
    content: [{ type: 'output_text', text: 'all done' }],
  },
  { type: 'ai-title', id: 'title-1', timestamp: 1792634385000, sessionId, cwd, aiTitle: '启动这个编辑器' },
]);

{
  fs.mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(path.join(home, 'workbuddy.db'));
  db.exec(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, title TEXT, custom_title TEXT, model TEXT,
    created_at INTEGER, updated_at INTEGER, last_activity_at INTEGER,
    status TEXT, deleted_at INTEGER
  )`);
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    sessionId, cwd, 'db title', 'custom title', 'deepseek-v4.1-flash',
    1792634378924, 1792634385000, 1792634385000, 'completed', null,
  );
  db.close();
}

const { AGENTS } = await import('../src/agents.js');
const { agentInfo } = await import('../src/core.js');

test('workbuddy: lists metadata from workbuddy.db and transcript files', () => {
  const [meta] = AGENTS.workbuddy.list();
  assert.equal(meta.id, sessionId);
  assert.equal(meta.cwd, cwd);
  assert.equal(meta.title, 'custom title');
  assert.equal(meta.file, file);
  assert.equal(meta.model, 'deepseek-v4.1-flash');
  assert.ok(meta.updatedAt);
});

test('workbuddy: loads user turns, assistant text and paired tools while skipping compaction noise', () => {
  const [meta] = AGENTS.workbuddy.list();
  const session = AGENTS.workbuddy.load(meta);
  assert.equal(session.title, '启动这个编辑器');
  assert.equal(session.cwd, cwd);
  assert.equal(session.model, 'deepseek-v4.1-flash');
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].role, 'user');
  assert.equal(session.messages[0].text, 'start the editor');
  assert.equal(session.messages[1].role, 'assistant');
  assert.deepEqual(session.messages[1].parts.map((part) => part.type), ['text', 'tool', 'text']);
  assert.equal(session.messages[1].parts[1].name, 'Read');
  assert.equal(session.messages[1].parts[1].output, 'file contents');
});

test('workbuddy: is available as a conversion target too', () => {
  assert.equal(AGENTS.workbuddy.sourceOnly, undefined);
  const info = agentInfo().find((agent) => agent.id === 'workbuddy');
  assert.equal(info.canTarget, true);
  assert.equal(info.sourceOnly, false);
});

test.after(() => {
  delete process.env.WORKBUDDY_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});
