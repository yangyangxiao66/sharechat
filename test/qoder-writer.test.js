import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-qoder-'));
process.env.QODER_HOME = path.join(tmp, 'qoder');
const dbPath = path.join(tmp, 'main.sqlite');

function createDb() {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE chat_sessions (
      session_id TEXT PRIMARY KEY,
      session_kind TEXT NOT NULL DEFAULT 'standard',
      conversation_mode TEXT NOT NULL DEFAULT 'normal',
      product_mode TEXT NOT NULL DEFAULT 'coding',
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      execution_kind TEXT,
      workspace_id TEXT,
      git_branch TEXT,
      model TEXT,
      permission_mode TEXT,
      additional_direcotries TEXT NOT NULL DEFAULT '{}',
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP NOT NULL,
      updated_at TIMESTAMP NOT NULL,
      execution_target_json TEXT NOT NULL DEFAULT '{}',
      registration_json TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      unread INTEGER NOT NULL DEFAULT 0,
      archived_at TIMESTAMP,
      deleted_at TIMESTAMP,
      message_envelope_version INTEGER
    );
    CREATE TABLE chat_session_messages (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT,
      sequence INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      feedback TEXT,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT,
      message_stream TEXT,
      voice_session_id TEXT,
      subtype TEXT,
      runtime_input_state TEXT,
      fork_availability TEXT,
      turn_started_at INTEGER,
      is_compaction_boundary INTEGER,
      has_visible_content INTEGER,
      payload_bytes INTEGER,
      payload_hash TEXT,
      payload_schema_version INTEGER,
      PRIMARY KEY (session_id, message_id)
    );
  `);
  db.close();
}

const sample = () => ({
  agent: 'workbuddy',
  id: 'workbuddy-source',
  title: '启动这个编辑器',
  cwd: 'D:\\shroomstudio\\MyceliumStudio-main\\MyceliumStudio-main',
  messages: [
    { role: 'user', text: '启动这个编辑器' },
    { role: 'assistant', parts: [{ type: 'text', text: '我先看一下项目结构。' }] },
    { role: 'user', text: '继续' },
    { role: 'assistant', parts: [{ type: 'text', text: '好的。' }] },
  ],
});

test('Qoder writer creates JSONL, index row, and message projections', async () => {
  createDb();
  const { writeQoderSession, qoderProjectSlug } = await import('../src/native/qoder.js');
  const cwd = sample().cwd;
  const r = writeQoderSession(sample(), 'WorkBuddy', { cwd, dbPath });
  assert.ok(fs.existsSync(r.file));
  assert.equal(path.dirname(r.file), path.join(process.env.QODER_HOME, 'projects', qoderProjectSlug(cwd)));
  const lines = fs.readFileSync(r.file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual([...new Set(lines.map((l) => l.type))].sort(), [
    'active-leaf', 'assistant', 'last-prompt', 'runtime-config', 'user', 'workspace-directories',
  ]);
  assert.deepEqual(lines[0].directories, [cwd]);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const session = db.prepare('select * from chat_sessions where session_id=?').get(r.sessionId);
  assert.equal(session.title, '启动这个编辑器');
  assert.equal(session.cwd, cwd);
  assert.equal(session.workspace_id, null);
  assert.equal(session.model, 'auto');
  assert.match(session.extra_json, /"importedFrom":"workbuddy"/);
  const messages = db.prepare('select * from chat_session_messages where session_id=? order by sequence').all(r.sessionId);
  assert.ok(messages.length >= 4);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].source, 'cli-import');
  assert.equal(messages[1].message_id, `assistant:${messages[0].message_id}`);
  assert.match(messages[1].payload_json, /forkBoundaryProviderId/);
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
