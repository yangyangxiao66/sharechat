import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-workbuddy-writer-'));
const home = path.join(tmp, 'workbuddy');
const cwd = path.join(tmp, 'project');
const fakeApp = path.join(tmp, 'WorkBuddy.exe');
fs.mkdirSync(cwd, { recursive: true });
fs.writeFileSync(fakeApp, '');
process.env.WORKBUDDY_HOME = home;
process.env.WORKBUDDY_EXE = fakeApp;
process.env.SHARECHAT_HOME = path.join(tmp, 'sharechat');
process.env.SHARECHAT_WORKBUDDY_SKIP_PROCESS_CHECK = '1';
fs.mkdirSync(home, { recursive: true });

const schema = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL, title TEXT,
    custom_title TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, last_activity_at INTEGER, deleted_at INTEGER,
    is_playground INTEGER NOT NULL DEFAULT 0, source_mode TEXT,
    is_background_automation INTEGER, mode TEXT, model TEXT, expert_id TEXT,
    expert_locale TEXT, expert_runtime_identity TEXT, expert_marketplace TEXT,
    permission_mode TEXT, use_sandbox_cli INTEGER, project_id TEXT,
    plugin_context_json TEXT, addon_selection TEXT, session_settings TEXT,
    last_user_prompt_expert_selection TEXT, context_window INTEGER,
    buddy_snapshot_id TEXT, buddy_binding_json TEXT, thought_level TEXT,
    transport TEXT NOT NULL DEFAULT 'local', conversation_origin TEXT,
    visibility TEXT, group_id TEXT, group_title TEXT, agent_dirty INTEGER,
    agent_dirty_at INTEGER, agent_last_synced INTEGER, verified_at INTEGER,
    unread INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE workspaces (path TEXT PRIMARY KEY, last_opened_at INTEGER NOT NULL);
`;
const dbFile = path.join(home, 'workbuddy.db');
{
  const db = new DatabaseSync(dbFile);
  db.exec(schema);
  db.prepare(`INSERT INTO sessions (
    id, cwd, user_id, title, status, created_at, updated_at, last_activity_at,
    is_playground, source_mode, mode, model, permission_mode, use_sandbox_cli,
    addon_selection, context_window, thought_level, transport, unread
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'template-session', 'C:/template', 'user-1', 'Template', 'completed',
    Date.now() - 1000, Date.now() - 1000, Date.now() - 1000,
    1, 'craft', 'craft', 'deepseek-v4.1-flash', 'fullAccess', 1,
    '{"version":1,"welcomeMode":"coding"}', 300000, 'high', 'local', 0,
  );
  db.close();
}

const { writeWorkBuddySession } = await import('../src/native/workbuddy.js');

test('workbuddy writer creates a resumable local session and transcript', () => {
  const source = {
    agent: 'codex',
    id: 'src-1',
    title: 'Imported task',
    cwd,
    messages: [
      { role: 'user', text: 'first ask' },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'checking' },
          { type: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'a.txt' },
          { type: 'text', text: 'done' },
        ],
      },
      { role: 'user', text: 'second ask' },
      { role: 'assistant', parts: [{ type: 'text', text: 'second answer' }] },
    ],
  };
  const result = writeWorkBuddySession(source, 'Codex', { cwd });

  assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
  assert.equal(result.resume.detached, true);
  assert.equal(result.workbuddyApp, fakeApp);
  assert.ok(result.file.startsWith(path.join(home, 'projects') + path.sep));
  assert.ok(fs.existsSync(result.file));
  assert.ok(fs.existsSync(result.backup));

  const records = fs.readFileSync(result.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].type, 'session-meta');
  assert.equal(records[0].sessionId, result.sessionId);
  const messages = records.filter((record) => record.type === 'message');
  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(messages[0].content[0].text, /first ask/);
  assert.match(messages[1].content[0].text, /external_agent_tool_call: Bash/);
  assert.equal(messages[1].parentId, messages[0].id);
  assert.equal(messages[2].parentId, messages[1].id);
  assert.equal(records.at(-1).type, 'ai-title');
  assert.match(records.at(-1).aiTitle, /Imported task（来自 Codex）/);

  const db = new DatabaseSync(dbFile);
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(result.sessionId);
  const workspace = db.prepare('SELECT * FROM workspaces WHERE path = ?').get(row.cwd);
  db.close();
  assert.ok(row);
  assert.equal(row.user_id, 'user-1');
  assert.equal(row.status, 'completed');
  assert.equal(row.title, 'Imported task（来自 Codex）');
  assert.ok(workspace);
});

test('workbuddy writer round-trips through the WorkBuddy reader', async () => {
  const { AGENTS } = await import('../src/agents.js');
  const rows = AGENTS.workbuddy.list();
  const meta = rows.find((row) => row.title === 'Imported task（来自 Codex）');
  assert.ok(meta);
  const loaded = AGENTS.workbuddy.load(meta);
  assert.equal(loaded.title, 'Imported task（来自 Codex）');
  assert.equal(loaded.messages.length, 4);
  assert.equal(loaded.messages[0].role, 'user');
  assert.equal(loaded.messages[0].text.includes('first ask'), true);
  assert.equal(
    loaded.messages[1].parts.some((part) => part.type === 'text' && part.text.includes('external_agent_tool_call: Bash')),
    true,
  );
});

test.after(() => {
  delete process.env.WORKBUDDY_HOME;
  delete process.env.WORKBUDDY_EXE;
  delete process.env.SHARECHAT_HOME;
  delete process.env.SHARECHAT_WORKBUDDY_SKIP_PROCESS_CHECK;
  fs.rmSync(tmp, { recursive: true, force: true });
});
