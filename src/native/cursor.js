// Write a native Cursor Desktop composer so the conversation shows up in
// Cursor's chat history and the agent receives it as real model history.
//
// Cursor is closed source; the layout is documented in src/cursor-store.js.
// To stay close to what Cursor itself writes, the newest real composer on this
// machine is used as a template: its composer/bubble/header JSON is cloned and
// only identity, timestamps and content are replaced. The model-visible history
// is the list of agentKv message blobs referenced from conversationState; the
// template's system prompt blob is reused and its <user_info> block is
// re-pointed at the target workspace.
//
// Safety: refuses while Cursor is running (it would overwrite the DB from
// memory), requires the project to have been opened in Cursor once (so it has
// a workspaceId), and backs up state.vscdb before writing.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { HOME } from '../util.js';
import { openDb, blobText } from '../sqlite.js';
import { globalDbPath, workspaceIdFor, isCursorRunning, stateHashes, decodeFields, encodeFields } from '../cursor-store.js';
import { flatten, timeline } from './flatten.js';

const BACKUPS_KEPT = 3;
const parse = (v) => { try { return JSON.parse(blobText(v)); } catch { return null; } };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Replace every array with [] and every plain object with its emptied self.
function emptied(value) {
  if (Array.isArray(value)) return [];
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, emptied(v)]));
  return value;
}

function backup(dbFile) {
  const dir = path.join(process.env.SHARECHAT_HOME || path.join(HOME, '.sharechat'), 'backups', 'cursor');
  const dest = path.join(dir, new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dest, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, path.join(dest, path.basename(dbFile) + suffix));
  }
  const old = fs.readdirSync(dir).sort().slice(0, -BACKUPS_KEPT);
  for (const name of old) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  return dest;
}

function loadTemplate(db, workspaceId) {
  const get = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
  const heads = db.prepare('SELECT composerId, workspaceId, value FROM composerHeaders '
    + 'WHERE COALESCE(isSubagent, 0) = 0 ORDER BY (workspaceId = ?) DESC, lastUpdatedAt DESC').all(workspaceId);
  for (const h of heads) {
    const composer = parse(get.get(`composerData:${h.composerId}`)?.value);
    const hashes = stateHashes(composer?.conversationState);
    if (!hashes.length) continue;
    const blobs = hashes.map((x) => ({ hash: x, msg: parse(get.get(`agentKv:blob:${x}`)?.value) }));
    const system = blobs.find((b) => b.msg?.role === 'system');
    const userInfo = blobs.find((b) => b.msg?.role === 'user' && typeof b.msg.content === 'string' && b.msg.content.includes('<user_info>'));
    const bubbles = (composer.fullConversationHeadersOnly || []).map((x) => parse(get.get(`bubbleId:${h.composerId}:${x.bubbleId}`)?.value)).filter(Boolean);
    const userBubble = bubbles.find((b) => b.type === 1);
    const aiBubble = bubbles.find((b) => b.type === 2 && b.text && !b.toolFormerData);
    if (!system || !userBubble || !aiBubble) continue;
    return { composer, head: parse(h.value) || {}, system, userInfo, userBubble, aiBubble };
  }
  throw new Error('本机没有可用作模板的 Cursor 会话：请先在 Cursor 里用 Agent 聊过至少一次');
}

const doc = (text) => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });

function bubbleFrom(template, { text, createdAt, user }) {
  const b = structuredClone(template);
  for (const k of ['thinking', 'thinkingDurationMs', 'thinkingStyle', 'capabilityType', 'toolFormerData', 'checkpointId', 'codeBlocks', 'allThinkingBlocks']) delete b[k];
  Object.assign(b, {
    bubbleId: randomUUID(),
    requestId: user ? randomUUID() : '',
    createdAt,
    text,
    tokenCount: { inputTokens: 0, outputTokens: 0 },
    conversationState: '~',
  });
  if (user) { b.richText = doc(text); b.context = emptied(b.context); }
  return b;
}

function conversationState(template, hashes, cwd) {
  const old = decodeFields(Buffer.from(template.conversationState.replace(/^~/, ''), 'base64'));
  const fields = hashes.map((h) => ({ field: 1, wt: 2, value: Buffer.from(h, 'hex') }));
  const prefix = (old.find((f) => f.field === 9)?.value.toString('utf8').match(/^.*\/server\//) || ['file:///app/backend/server/'])[0];
  fields.push({ field: 9, wt: 2, value: prefix + encodeURI(cwd) });
  for (const f of old) if ([10, 21, 22, 27].includes(f.field)) fields.push(f);
  fields.push({ field: 26, wt: 0, value: Date.now() });
  return '~' + encodeFields(fields).toString('base64');
}

export function writeCursorSession(session, sourceLabel, { cwd }) {
  // The process check guards the real Cursor DB; tests point CURSOR_USER_DIR at a scratch copy.
  if (!process.env.SHARECHAT_CURSOR_SKIP_PROCESS_CHECK && isCursorRunning()) {
    throw new Error('请先完全退出 Cursor 再转换：Cursor 运行时会用内存里的数据覆盖写入的会话');
  }
  const dbFile = globalDbPath();
  if (!fs.existsSync(dbFile)) throw new Error('没有找到 Cursor 的数据库，请确认已安装并运行过 Cursor 桌面端');
  const workspaceId = workspaceIdFor(cwd);
  if (!workspaceId) throw new Error(`请先用 Cursor 打开一次项目目录 ${cwd}，然后退出 Cursor 再转换`);

  const backupDir = backup(dbFile);
  const db = openDb(dbFile, { readOnly: false });
  try {
    const t = loadTemplate(db, workspaceId);
    const msgs = flatten(session, sourceLabel);
    const times = timeline(msgs).map((d) => d.toISOString());
    const composerId = randomUUID();
    const now = Date.now();
    const title = `${session.title || '导入的会话'}（来自 ${sourceLabel}）`;

    // Model-visible history: system prompt, <user_info>, then the conversation.
    const newBlobs = [];
    const addBlob = (msg) => {
      const buf = Buffer.from(JSON.stringify(msg), 'utf8');
      const hash = sha256(buf);
      newBlobs.push({ hash, buf });
      return hash;
    };
    const hashes = [t.system.hash];
    if (t.userInfo) {
      const info = { ...t.userInfo.msg, content: t.userInfo.msg.content.replace(/Workspace Path: .*/g, `Workspace Path: ${cwd}`) };
      hashes.push(addBlob(info));
    }
    msgs.forEach((m, i) => {
      hashes.push(addBlob(m.role === 'user'
        ? { role: 'user', content: [{ type: 'text', text: `<user_query>\n${m.text}\n</user_query>` }] }
        : { role: 'assistant', content: [{ type: 'text', text: m.text }], id: String(i + 1) }));
    });

    // UI bubbles.
    const bubbles = msgs.map((m, i) => bubbleFrom(m.role === 'user' ? t.userBubble : t.aiBubble, { text: m.text, createdAt: times[i], user: m.role === 'user' }));
    const headers = bubbles.map((b) => ({
      bubbleId: b.bubbleId, type: b.type, createdAt: b.createdAt,
      grouping: { isRenderable: true, hasText: true, toolDisplayComputed: true },
    }));

    const workspaceIdentifier = {
      ...(t.head.workspaceIdentifier || t.composer.workspaceIdentifier || {}),
      id: workspaceId,
      uri: { ...(t.head.workspaceIdentifier?.uri || {}), fsPath: cwd, external: undefined, path: undefined },
    };
    const composer = {
      ...structuredClone(t.composer),
      composerId, name: title, text: '', richText: doc(''),
      fullConversationHeadersOnly: headers, conversationMap: {}, conversationState: conversationState(t.composer, hashes, cwd),
      status: 'completed', generatingBubbleIds: [], context: emptied(t.composer.context),
      codeBlockData: {}, originalFileStates: {}, newlyCreatedFiles: [], newlyCreatedFolders: [],
      createdAt: now, lastUpdatedAt: now, conversationCheckpointLastUpdatedAt: now,
      usageData: {}, contextUsagePercent: 0, contextTokensUsed: 0, todos: [], queueItems: [],
      subComposerIds: [], subagentComposerIds: [], totalLinesAdded: 0, totalLinesRemoved: 0,
      addedFiles: 0, removedFiles: 0, filesChangedCount: 0, subtitle: '', trackedGitRepos: [],
      hasUnreadMessages: false, isDraft: false, latestChatGenerationUUID: randomUUID(),
      blobEncryptionKey: randomBytes(32).toString('base64'),
      speculativeSummarizationEncryptionKey: randomBytes(32).toString('base64'),
      workspaceIdentifier,
    };
    for (const k of ['promptTokenBreakdown', 'promptContextUsageTree', 'checkpointId']) delete composer[k];
    const head = {
      ...structuredClone(t.head),
      composerId, name: title, createdAt: now, lastUpdatedAt: now, conversationCheckpointLastUpdatedAt: now,
      hasUnreadMessages: false, contextUsagePercent: 0, totalLinesAdded: 0, totalLinesRemoved: 0,
      filesChangedCount: 0, subtitle: '', isArchived: false, isDraft: false, numSubComposers: 0, workspaceIdentifier,
    };

    db.exec('BEGIN IMMEDIATE');
    try {
      const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
      for (const b of newBlobs) put.run(`agentKv:blob:${b.hash}`, b.buf);
      for (const b of bubbles) put.run(`bubbleId:${composerId}:${b.bubbleId}`, JSON.stringify(b));
      put.run(`composerData:${composerId}`, JSON.stringify(composer));
      db.prepare('INSERT INTO composerHeaders (composerId, workspaceId, createdAt, lastUpdatedAt, isArchived, isSubagent, recency, checkpointAt, value) '
        + 'VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?)').run(composerId, workspaceId, now, now, now, JSON.stringify(head));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return { sessionId: composerId, file: dbFile, backup: backupDir, resume: { cmd: 'cursor', args: [cwd] } };
  } finally {
    db.close();
  }
}
