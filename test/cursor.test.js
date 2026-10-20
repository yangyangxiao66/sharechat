import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-cursor-'));
const userDir = path.join(tmp, 'User');
const project = path.join(tmp, 'proj');
let cursor, store, NATIVE, openDb;

// A Cursor store shaped like Cursor Desktop's: one real-looking template composer.
function seed() {
  fs.mkdirSync(path.join(userDir, 'globalStorage'), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(userDir, 'workspaceStorage', 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(userDir, 'workspaceStorage', 'ws1', 'workspace.json'), JSON.stringify({ folder: pathToFileURL(project).href }));
  const db = openDb(store.globalDbPath(), { readOnly: false });
  db.exec(`CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
    CREATE TABLE composerHeaders (composerId TEXT PRIMARY KEY, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER,
      isArchived INTEGER, isSubagent INTEGER, recency INTEGER, checkpointAt INTEGER, value TEXT);`);
  const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  const blob = (msg) => {
    const buf = Buffer.from(JSON.stringify(msg));
    const h = createHash('sha256').update(buf).digest('hex');
    put.run(`agentKv:blob:${h}`, buf);
    return h;
  };
  const hashes = [
    blob({ role: 'system', content: 'You are an AI coding assistant.' }),
    blob({ role: 'user', content: `<user_info>\nWorkspace Path: ${project}\n</user_info>` }),
    blob({ role: 'user', content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nrun the build\n</user_query>' }] }),
    blob({ role: 'assistant', content: [{ type: 'text', text: 'Running it.' }, { type: 'tool-call', toolCallId: 't1', toolName: 'Shell', args: { command: 'npm run build' } }], id: '1' }),
    blob({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Shell', result: 'ok' }] }),
    blob({ role: 'user', content: [{ type: 'text', text: 'Background task finished.' }] }),
    blob({ role: 'assistant', content: [{ type: 'text', text: 'Build passed.' }], id: '2' }),
  ];
  const state = '~' + store.encodeFields([
    ...hashes.map((h) => ({ field: 1, wt: 2, value: Buffer.from(h, 'hex') })),
    { field: 9, wt: 2, value: 'file:///app/backend/server/' + encodeURI(project) },
    { field: 22, wt: 2, value: 'ide' },
  ]).toString('base64');
  const id = randomUUID();
  const ub = { _v: 3, type: 1, bubbleId: randomUUID(), text: 'run the build', richText: '{}', context: { fileSelections: ['x'] } };
  const ab = { _v: 3, type: 2, bubbleId: randomUUID(), text: 'Running it.' };
  put.run(`bubbleId:${id}:${ub.bubbleId}`, JSON.stringify(ub));
  put.run(`bubbleId:${id}:${ab.bubbleId}`, JSON.stringify(ab));
  const workspaceIdentifier = { id: 'ws1', uri: { $mid: 1, fsPath: project } };
  put.run(`composerData:${id}`, JSON.stringify({
    _v: 18, composerId: id, name: 'Build it', conversationState: state, status: 'completed',
    fullConversationHeadersOnly: [{ bubbleId: ub.bubbleId, type: 1 }, { bubbleId: ab.bubbleId, type: 2 }],
    context: { fileSelections: ['x'] }, workspaceIdentifier,
  }));
  db.prepare('INSERT INTO composerHeaders VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?)')
    .run(id, 'ws1', 1000, 2000, 2000, JSON.stringify({ type: 'head', composerId: id, name: 'Build it', workspaceIdentifier }));
  db.close();
}

before(async () => {
  process.env.CURSOR_USER_DIR = userDir;
  process.env.CURSOR_HOME = path.join(tmp, 'dot-cursor');
  process.env.SHARECHAT_HOME = path.join(tmp, 'sharechat');
  process.env.SHARECHAT_CURSOR_SKIP_PROCESS_CHECK = '1';
  cursor = await import('../src/adapters/cursor.js');
  store = await import('../src/cursor-store.js');
  ({ NATIVE } = await import('../src/native/index.js'));
  ({ openDb } = await import('../src/sqlite.js'));
  seed();
});

const flat = (s) => s.messages.map((m) => (m.role === 'user' ? `U:${m.text}` : 'A:' + m.parts.map((p) => (p.type === 'text' ? p.text : `[${p.name}=>${p.output}]`)).join('|')));

test('cursor protobuf: field list round-trips', () => {
  const fields = [{ field: 1, wt: 2, value: Buffer.alloc(32, 7) }, { field: 26, wt: 0, value: 1784734610200 }, { field: 22, wt: 2, value: Buffer.from('ide') }];
  const back = store.decodeFields(store.encodeFields(fields));
  assert.deepEqual(back.map((f) => [f.field, f.wt]), [[1, 2], [26, 0], [22, 2]]);
  assert.equal(back[1].value, 1784734610200);
  assert.equal(back[2].value.toString(), 'ide');
});

test('cursor reader: model history with tools; drops system, user_info and unwrapped injections', () => {
  const [meta] = cursor.list();
  assert.equal(meta.cwd, project);
  const s = cursor.load(meta);
  assert.equal(s.title, 'Build it');
  assert.deepEqual(flat(s), ['U:run the build', 'A:Running it.|[Shell=>ok]|Build passed.']);
});

test('cursor writer: imported composer is listed and its model history reads back', () => {
  const session = { agent: 'claude', id: 'abc', title: 'From Claude', cwd: project, messages: [
    { role: 'user', text: 'fix the bug' },
    { role: 'assistant', parts: [{ type: 'text', text: 'fixed in a.js' }] },
  ] };
  const r = NATIVE.cursor(session, 'Claude Code', { cwd: project });
  assert.equal(r.resume.cmd, 'cursor');
  assert.ok(fs.existsSync(r.backup), 'backup created before writing');
  const meta = cursor.list().find((m) => m.id === r.sessionId);
  assert.ok(meta, 'listed');
  assert.equal(meta.title, 'From Claude（来自 Claude Code）');
  const texts = flat(cursor.load(meta));
  assert.match(texts[0], /^U:\[本会话由 sharechat 从 Claude Code 导入[\s\S]*fix the bug$/);
  assert.equal(texts[1], 'A:fixed in a.js');

  // The model history must start with the template's system prompt and a re-pointed <user_info>.
  const db = openDb(store.globalDbPath());
  const composer = JSON.parse(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${r.sessionId}`).value);
  const first = store.stateHashes(composer.conversationState).slice(0, 2)
    .map((h) => JSON.parse(Buffer.from(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`agentKv:blob:${h}`).value).toString()));
  const bubble = JSON.parse(db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`bubbleId:${r.sessionId}:${composer.fullConversationHeadersOnly[0].bubbleId}`).value);
  db.close();
  assert.equal(first[0].role, 'system');
  assert.match(first[1].content, /Workspace Path: /);
  assert.deepEqual(bubble.context.fileSelections, [], 'template attachments are not copied');
});

test('cursor writer: refuses a project Cursor has never opened', () => {
  const other = path.join(tmp, 'never-opened');
  fs.mkdirSync(other, { recursive: true });
  const session = { agent: 'claude', id: 'x', title: 't', cwd: other, messages: [{ role: 'user', text: 'hi' }] };
  assert.throws(() => NATIVE.cursor(session, 'Claude Code', { cwd: other }), /请先用 Cursor 打开一次项目目录/);
});
