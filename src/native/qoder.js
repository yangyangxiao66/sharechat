// Qoder desktop sessions: a Claude-style JSONL under
// ~/.qoder/projects/<project>/<id>.jsonl plus an index row and message
// projections in %APPDATA%/com.qoder.app.stable/main.sqlite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HOME } from '../util.js';
import { flatten, timeline, uuidv7 } from './flatten.js';
import { historyBudget } from './budget.js';

const APP_ID = 'com.qoder.app.stable';

export function qoderHome() {
  return process.env.QODER_HOME || path.join(HOME, '.qoder');
}

export function qoderAppDataDir() {
  if (process.env.QODER_APP_DATA) return process.env.QODER_APP_DATA;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), APP_ID);
  }
  if (process.platform === 'darwin') {
    return path.join(HOME, 'Library', 'Application Support', APP_ID);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), APP_ID);
}

export function qoderDbPath() {
  return path.join(qoderAppDataDir(), 'main.sqlite');
}

export function qoderProjectSlug(cwd) {
  return path.resolve(cwd).replace(/[:\\/]/g, '-');
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupDatabase(db) {
  const dir = path.join(qoderHome(), 'backups', 'sharechat', stamp());
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'main.sqlite');
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

function messageId(seed) {
  return `msg_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function payloads(role, text, turnId) {
  if (role === 'user') {
    return {
      payload: JSON.stringify({ parts: [{ id: `${turnId}:text:0`, type: 'text', text, parentToolUseId: null }] }),
      fork: '',
    };
  }
  const fork = messageId(`${turnId}:${text}`);
  return {
    payload: JSON.stringify({
      forkBoundaryProviderId: fork,
      completedAt: new Date().toISOString(),
      parts: [{ id: `${turnId}:text:0`, type: 'text', text, parentToolUseId: null }],
    }),
    fork,
  };
}

export function writeQoderSession(session, sourceLabel, { cwd, maxTokens, dbPath = qoderDbPath() } = {}) {
  const msgs = flatten(session, sourceLabel, { maxTokens: maxTokens ?? historyBudget('claude') });
  const times = timeline(msgs);
  const id = uuidv7();
  const now = new Date();
  const records = [];
  let parentUuid = null;
  let turnId = '';
  let lastUserText = '';

  msgs.forEach((m, i) => {
    const uuid = uuidv7();
    const ts = times[i] || now;
    if (m.role === 'user') {
      turnId = uuid;
      lastUserText = m.text;
      records.push({ role: 'user', text: m.text, ts, uuid, parentUuid, turnId, messageId: uuid });
    } else {
      if (!turnId) {
        turnId = uuidv7();
        lastUserText = '';
      }
      records.push({ role: 'assistant', text: m.text, ts, uuid, parentUuid, turnId, messageId: `assistant:${turnId}` });
    }
    parentUuid = uuid;
  });

  const project = qoderProjectSlug(cwd);
  const dir = path.join(qoderHome(), 'projects', project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    { type: 'workspace-directories', sessionId: id, directories: [cwd] },
    { type: 'runtime-config', sessionId: id, model: 'auto', reasoningEffort: null, contextWindow: null, timestamp: now.getTime() },
    ...records.map((r) => r.role === 'user'
      ? {
          type: 'user', uuid: r.uuid, timestamp: r.ts.toISOString(), parentUuid: r.parentUuid,
          message: { role: 'user', content: [{ type: 'text', text: r.text }] },
          permissionMode: 'bypassPermissions', sessionId: id, cwd, userType: 'external',
          entrypoint: 'cli', version: '1.1.75', gitBranch: 'HEAD', isSidechain: false,
        }
      : {
          type: 'assistant', uuid: r.uuid, timestamp: r.ts.toISOString(), parentUuid: r.parentUuid,
          message: {
            id: messageId(r.uuid), type: 'message', role: 'assistant', model: 'auto',
            stop_reason: null, stop_sequence: null, content: [{ type: 'text', text: r.text }],
          },
          sessionId: id, cwd, userType: 'external', entrypoint: 'cli',
          version: '1.1.75', gitBranch: 'HEAD', isSidechain: false,
        }),
    { type: 'last-prompt', sessionId: id, lastPrompt: lastUserText },
    { type: 'active-leaf', sessionId: id, leafUuid: records[records.length - 1]?.uuid || id, explicit: false, timestamp: now.getTime() },
  ];
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  let db;
  try {
    if (!fs.existsSync(dbPath)) throw new Error('未找到 Qoder 桌面版数据，请先启动一次 Qoder');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=5000');
    db.exec('PRAGMA foreign_keys=ON');
    backupDatabase(db);

    const title = String(session.title || lastUserText || '未命名会话').slice(0, 200);
    const sourceId = session.agent || 'sharechat';
    const extra = JSON.stringify({ source: 'workspace', importedFrom: sourceId, historyRecoveryBackgroundAgents: [] });
    const wsId = `ws_${crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex')}`;
    const target = JSON.stringify({
      mode: 'local',
      host: { id: 'local', kind: 'local', label: 'Local' },
      workspace: { id: wsId, path: path.resolve(cwd) },
    });
    const createdAt = now.getTime();
    const updatedAt = createdAt;

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(`
        INSERT INTO chat_sessions (
          session_id, session_kind, conversation_mode, product_mode, title, cwd, execution_kind,
          workspace_id, git_branch, model, permission_mode, additional_direcotries, extra_json,
          created_at, updated_at, execution_target_json, archived, unread, message_envelope_version
        ) VALUES (?, 'standard', 'normal', 'coding', ?, ?, 'local', NULL, NULL, 'auto', 'bypassPermissions', '{}', ?, ?, ?, ?, 0, 0, 1)
      `).run(id, title, path.resolve(cwd), extra, createdAt, updatedAt, target);

      const insertMessage = db.prepare(`
        INSERT INTO chat_session_messages (
          session_id, message_id, turn_id, sequence, payload_json, status, feedback, source,
          created_at, updated_at, role, message_stream, voice_session_id, subtype, runtime_input_state,
          fork_availability, turn_started_at, is_compaction_boundary, has_visible_content,
          payload_bytes, payload_hash, payload_schema_version
        ) VALUES (?, ?, ?, ?, ?, 'completed', NULL, 'cli-import', ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, 0, 1, ?, ?, 2)
      `);
      records.forEach((r, index) => {
        const { payload } = payloads(r.role, r.text, r.messageId);
        const ts = r.ts.getTime();
        insertMessage.run(
          id, r.messageId, r.turnId, index + 1, payload, ts, ts, r.role,
          r.role === 'assistant' ? ts : null,
          Buffer.byteLength(payload),
          crypto.createHash('sha256').update(payload).digest('hex')
        );
      });
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    }
  } catch (error) {
    try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
    throw error;
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }

  return { sessionId: id, file, resume: { cmd: 'qoder', args: ['ide', '--new-window', path.resolve(cwd)] } };
}
