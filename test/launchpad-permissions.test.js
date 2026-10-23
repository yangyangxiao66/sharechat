import test from 'node:test';
import assert from 'node:assert/strict';
import launchpad from '../modules/terminal/agent/launchpad.js';

const { buildLaunchCommand } = launchpad;

test('Claude Code all-permissions flag is opt-in', () => {
  assert.equal(buildLaunchCommand('claude'), 'claude');
  assert.equal(
    buildLaunchCommand('claude', '', { skipPermissions: true }),
    'claude --dangerously-skip-permissions'
  );
  assert.equal(
    buildLaunchCommand('claude', '--model opus', { skipPermissions: true }),
    'claude --dangerously-skip-permissions --model opus'
  );
});

test('Claude Code all-permissions flag is not duplicated', () => {
  assert.equal(
    buildLaunchCommand('claude', '--dangerously-skip-permissions', { skipPermissions: true }),
    'claude --dangerously-skip-permissions'
  );
});

test('other agents never receive the Claude-only flag', () => {
  assert.equal(buildLaunchCommand('codex', '', { skipPermissions: true }), 'codex');
  assert.equal(buildLaunchCommand('gemini', '--model auto', { skipPermissions: true }), 'gemini --model auto');
});
