import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfResume } from '../src/native/index.js';
import { agentInfo, resumeNativeSession } from '../src/core.js';

test('each agent can resume its own native session', () => {
  const cwd = path.resolve('repo');
  const meta = { id: 'abc-123' };
  assert.deepEqual(selfResume('claude', meta, cwd), { cmd: 'claude', args: ['--resume', 'abc-123'] });
  assert.deepEqual(selfResume('codex', meta, cwd), { cmd: 'codex', args: ['resume', 'abc-123'] });
  assert.deepEqual(selfResume('qwen', meta, cwd), { cmd: 'qwen', args: ['--resume', 'abc-123'] });
  assert.deepEqual(selfResume('gemini', meta, cwd), { cmd: 'gemini', args: ['--resume', 'abc-123'] });
  assert.deepEqual(selfResume('opencode', meta, cwd), { cmd: 'opencode', args: ['--session', 'abc-123'] });
  assert.deepEqual(selfResume('grok', meta, cwd), { cmd: 'grok', args: ['--resume', 'abc-123'] });
  assert.deepEqual(selfResume('cursor', meta, cwd), { cmd: 'cursor', args: [cwd] });
  assert.deepEqual(selfResume('chatgpt', meta, cwd), { url: 'codex://threads/abc-123' });
});

test('source-only and malformed sessions have no self resume', () => {
  assert.equal(selfResume('workbuddy', { id: 'abc' }, path.resolve('.')), null);
  assert.equal(selfResume('claude', {}, path.resolve('.')), null);
  assert.equal(selfResume('cursor', { id: 'abc' }, ''), null);
});

test('agent info exposes which sources support self resume', () => {
  const info = Object.fromEntries(agentInfo().map((agent) => [agent.id, agent]));
  assert.equal(info.claude.canSelfResume, true);
  assert.equal(info.codex.canSelfResume, true);
  assert.equal(info.grok.canSelfResume, true);
  assert.equal(info.cursor.canSelfResume, true);
  assert.equal(info.chatgpt.canSelfResume, true);
  assert.equal(info.chatgpt.canTarget, true);
  assert.equal(info.workbuddy.canSelfResume, false);
});

test('self resume restores the original session in its own directory', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sharechat-self-resume-'));
  try {
    const r = resumeNativeSession({ agent: 'claude', id: 'abc-123', cwd, title: 'example' });
    assert.equal(r.native, true);
    assert.equal(r.source, 'claude');
    assert.equal(r.target, 'claude');
    assert.equal(r.cwd, path.resolve(cwd));
    assert.deepEqual(r.resume, { cmd: 'claude', args: ['--resume', 'abc-123'] });
    const desktop = resumeNativeSession({ agent: 'chatgpt', id: 'abc-123', cwd, title: 'example' });
    assert.equal(desktop.openUrl, 'codex://threads/abc-123');
    assert.equal(desktop.resume, undefined);
    assert.throws(
      () => resumeNativeSession({ agent: 'workbuddy', id: 'abc', cwd }),
      /暂不支持原生续聊/
    );
    assert.throws(
      () => resumeNativeSession({ agent: 'claude', id: 'abc', cwd: path.join(cwd, 'missing') }),
      /工作目录不存在/
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
