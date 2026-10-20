import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resumeCommand } from '../desktop/resume-command.js';

test('resume arguments remain literal PowerShell strings', () => {
  assert.equal(resumeCommand({ cmd: 'codex', args: ['resume', 'abc-123'] }), "& 'codex' 'resume' 'abc-123'");
  assert.equal(resumeCommand({ cmd: 'opencode', args: ['--model', "provider/model's $value; $(exit)"] }),
    "& 'opencode' '--model' 'provider/model''s $value; $(exit)'");
});

test('only known agent executables and single-line arguments are accepted', () => {
  assert.throws(() => resumeCommand({ cmd: 'powershell', args: ['-Command', 'exit'] }));
  assert.throws(() => resumeCommand({ cmd: 'grok', args: ['--resume', 'abc\nexit'] }));
  assert.throws(() => resumeCommand({ cmd: 'claude', args: [null] }));
});
