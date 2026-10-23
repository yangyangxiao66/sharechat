// Write a WorkBuddy Desktop session so it appears in WorkBuddy's session list
// and can be continued there. WorkBuddy's storage is private: a row in
// workbuddy.db plus a JSONL transcript under projects/<compressed-cwd>/.
//
// WorkBuddy keeps its database in memory while running, so writing is allowed
// only after the desktop app (including its tray process) has fully exited.
// The newest local session is used as a template so model/permission fields
// match this machine.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { home } from '../adapters/workbuddy.js';
import { openDb } from '../sqlite.js';
import { flatten, timeline, uuidv7 } from './flatten.js';
import { historyBudget } from './budget.js';

const BACKUPS_KEPT = 3;

function nowMs() {
  return Date.now();
}

function isWorkBuddyRunning() {
  if (process.env.SHARECHAT_WORKBUDDY_SKIP_PROCESS_CHECK === '1') return false;
  if (process.platform !== 'win32') {
    const result = spawnSync('pgrep', ['-fi', 'WorkBuddy'], { encoding: 'utf8' });
    return result.status === 0;
  }
  const probe = (name) => {
    const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    }).stdout || '';
    return new RegExp(`\\b${name.replace('.', '\\.')}\\b`, 'i').test(out);
  };
  return probe('WorkBuddy.exe') || probe('WorkBuddyAI.exe');
}

function findWorkBuddyApp() {
  const candidates = [
    process.env.WORKBUDDY_EXE,
    'D:\\workbuddycn\\WorkBuddy.exe',
    'D:\\workbuddy\\WorkBuddyAI\\WorkBuddyAI.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'WorkBuddy', 'WorkBuddy.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'WorkBuddy', 'WorkBuddy.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || '';
}

function canonicalCwd(cwd) {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved).replace(/\\/g, '/');
  } catch {
    return resolved.replace(/\\/g, '/');
  }
}

// WorkBuddy's compressWorkspacePathName after canonicalization. Its drive
// letter is lower-cased in existing project folders.
function projectFolder(cwd) {
  const value = cwd
    .replace(/^([A-Za-z]):/, (_, drive) => `${drive.toLowerCase()}:`)
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-');
  if (Buffer.byteLength(value, 'utf8') > 255) {
    throw new Error('工作目录路径过长，WorkBuddy 无法创建对应的项目目录');
  }
  return value;
}

function backupDatabase(dbFile) {
  const root = process.env.SHARECHAT_HOME || path.join(os.homedir(), '.sharechat');
  const dir = path.join(root, 'backups', 'workbuddy', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = dbFile + suffix;
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(dir, path.basename(dbFile) + suffix));
    }
  }
  const parent = path.dirname(dir);
  const old = fs.readdirSync(parent).filter((name) => fs.statSync(path.join(parent, name)).isDirectory()).sort();
  for (const name of old.slice(0, Math.max(0, old.length - BACKUPS_KEPT))) {
    fs.rmSync(path.join(parent, name), { recursive: true, force: true });
  }
  return dir;
}

function cloneTemplateRow(template, { id, cwd, title, now }) {
  return {
    ...template,
    id,
    cwd,
    title,
    custom_title: null,
    status: 'completed',
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    deleted_at: null,
    unread: 0,
    agent_dirty: null,
    agent_dirty_at: null,
    agent_last_synced: null,
    verified_at: null,
    project_id: null,
    conversation_origin: null,
    visibility: null,
    group_id: null,
    group_title: null,
    expert_id: null,
    expert_locale: null,
    expert_runtime_identity: null,
    expert_marketplace: null,
    buddy_snapshot_id: null,
    buddy_binding_json: null,
    plugin_context_json: null,
    session_settings: null,
    last_user_prompt_expert_selection: null,
    is_background_automation: null,
    transport: 'local',
  };
}

function transcriptRecords(session, sourceLabel, { sessionId, cwd, model, maxTokens }) {
  const messages = flatten(session, sourceLabel, {
    maxTokens: maxTokens ?? historyBudget('workbuddy'),
  });
  if (!messages.length) throw new Error('来源会话没有可写入的消息');
  const times = timeline(messages);
  const now = nowMs();
  const records = [{
    type: 'session-meta',
    id: uuidv7(),
    sessionId,
    timestamp: times[0].getTime(),
    meta: { 'codebuddy.ai/hostKind': 'unopted' },
  }];
  let parentId = null;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const id = uuidv7();
    const record = {
      id,
      ...(parentId ? { parentId } : {}),
      timestamp: times[index].getTime(),
      type: 'message',
      role: message.role,
      content: [{
        type: message.role === 'user' ? 'input_text' : 'output_text',
        text: message.text,
      }],
      providerData: message.role === 'user'
        ? { startsNewUserRequest: true, agent: 'cli' }
        : { agent: 'cli', ...(model ? { model } : {}) },
      sessionId,
      cwd,
      _meta: {},
      ...(message.role === 'assistant' ? { status: 'completed' } : {}),
    };
    records.push(record);
    parentId = id;
  }
  records.push({
    type: 'ai-title',
    id: uuidv7(),
    sessionId,
    cwd,
    timestamp: now,
    aiTitle: `${session.title || '导入的会话'}（来自 ${sourceLabel}）`,
  });
  return { messages, records };
}

export function writeWorkBuddySession(session, sourceLabel, { cwd, maxTokens } = {}) {
  if (isWorkBuddyRunning()) {
    throw new Error('请先完全退出 WorkBuddy（包括托盘进程）再转换；WorkBuddy 运行时会覆盖它自己的会话数据库。');
  }
  const homeDir = home();
  const dbFile = path.join(homeDir, 'workbuddy.db');
  if (!fs.existsSync(dbFile)) {
    throw new Error('没有找到 WorkBuddy 会话数据库，请先打开并登录 WorkBuddy，再完成一个会话');
  }
  const cwdStored = canonicalCwd(cwd || session.cwd || process.cwd());
  if (!fs.existsSync(cwdStored)) throw new Error(`工作目录不存在：${cwdStored}`);

  const backupDir = backupDatabase(dbFile);
  const db = openDb(dbFile, { readOnly: false });
  try {
    let template;
    try {
      template = db.prepare(`SELECT * FROM sessions WHERE deleted_at IS NULL AND transport = 'local'
        ORDER BY last_activity_at DESC, updated_at DESC LIMIT 1`).get();
    } catch {
      template = db.prepare(`SELECT * FROM sessions WHERE deleted_at IS NULL
        ORDER BY last_activity_at DESC, updated_at DESC LIMIT 1`).get();
    }
    if (!template?.user_id) {
      throw new Error('WorkBuddy 里还没有可作为模板的本地会话，请先在 WorkBuddy 里完成一次对话');
    }

    const sessionId = crypto.randomUUID();
    const title = `${session.title || '导入的会话'}（来自 ${sourceLabel}）`;
    const now = nowMs();
    const row = cloneTemplateRow(template, { id: sessionId, cwd: cwdStored, title, now });
    const folderName = projectFolder(cwdStored);
    const projectDir = path.join(homeDir, 'projects', folderName);
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    const { records } = transcriptRecords(session, sourceLabel, {
      sessionId,
      cwd: cwdStored,
      model: row.model || '',
      maxTokens,
    });

    fs.mkdirSync(projectDir, { recursive: true });
    const tempFile = `${file}.sharechat.tmp`;
    fs.writeFileSync(tempFile, records.map((record) => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
    fs.renameSync(tempFile, file);

    try {
      db.exec('BEGIN IMMEDIATE');
      const columns = Object.keys(row);
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT INTO sessions (${columns.map((column) => `"${column}"`).join(', ')})
        VALUES (${placeholders})`).run(...columns.map((column) => row[column]));
      try {
        db.prepare(`INSERT INTO workspaces (path, last_opened_at) VALUES (?, ?)
          ON CONFLICT(path) DO UPDATE SET last_opened_at = excluded.last_opened_at`).run(cwdStored, now);
      } catch {
        // workspaces is an optional index; the session row is authoritative.
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      fs.rmSync(file, { force: true });
      throw error;
    }

    const appPath = findWorkBuddyApp();
    return {
      sessionId,
      file,
      backup: backupDir,
      workbuddyApp: appPath,
      resume: {
        cmd: appPath || 'WorkBuddy',
        args: [],
        detached: true,
      },
    };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
