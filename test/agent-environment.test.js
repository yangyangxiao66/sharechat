import test from 'node:test';
import assert from 'node:assert/strict';
import environment from '../modules/terminal/agent/environment.js';

test('Windows terminals opt out of the crashing OpenCode watcher without mutating the host', () => {
  const original = { Path: 'C:\\Node', CUSTOM: 'preserved' };
  assert.deepEqual(environment.agentEnvironment(original, 'win32'), {
    ...original, OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
  });
  assert.equal(original.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER, undefined);
});

test('OpenCode watcher compatibility preserves explicit overrides and other platforms', () => {
  const explicit = { OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: 'false' };
  assert.deepEqual(environment.agentEnvironment(explicit, 'win32'), explicit);
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(environment.agentEnvironment({ TERM: 'xterm-256color' }, platform), { TERM: 'xterm-256color' });
  }
});
