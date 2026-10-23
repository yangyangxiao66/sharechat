import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertClaudeLaunchAllowed,
  checkClaudeRegion,
  resetClaudeGuardCache,
} from '../src/claude-guard.js';

const geo = (country) => async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ country_code: country }) });
const trace = (loc) => async () => ({ ok: true, status: 200, text: async () => `ip=203.0.113.1\nloc=${loc}\n` });
const offline = async () => { throw new Error('offline'); };

test('mainland China is blocked; HK and other regions are allowed', async () => {
  resetClaudeGuardCache();
  assert.deepEqual(await checkClaudeRegion({ fetchImpl: geo('CN'), noCache: true }), {
    allowed: false, country: 'CN', reason: 'mainland',
  });
  assert.deepEqual(await checkClaudeRegion({ fetchImpl: geo('HK'), noCache: true }), {
    allowed: true, country: 'HK', reason: 'ok',
  });
  assert.deepEqual(await checkClaudeRegion({ fetchImpl: geo('US'), noCache: true }), {
    allowed: true, country: 'US', reason: 'ok',
  });
});

test('falls back to the trace endpoint when JSON services fail', async () => {
  resetClaudeGuardCache();
  const fetchImpl = async (url) => (url.includes('ipwho')
    ? { ok: false, status: 503, text: async () => '' }
    : trace('CN')());
  assert.deepEqual(await checkClaudeRegion({ fetchImpl, noCache: true }), {
    allowed: false, country: 'CN', reason: 'mainland',
  });
});

test('unknown region fails closed', async () => {
  resetClaudeGuardCache();
  assert.deepEqual(await checkClaudeRegion({ fetchImpl: offline, noCache: true }), {
    allowed: false, country: '', reason: 'unknown',
  });
});

test('assertClaudeLaunchAllowed gives a clear reason', async () => {
  await assert.rejects(
    () => assertClaudeLaunchAllowed({ fetchImpl: geo('CN'), noCache: true }),
    /中国大陆/
  );
  await assert.rejects(
    () => assertClaudeLaunchAllowed({ fetchImpl: offline, noCache: true }),
    /无法确认/
  );
});

test('the region result is cached until reset', async () => {
  resetClaudeGuardCache();
  assert.equal((await checkClaudeRegion({ fetchImpl: geo('CN') })).country, 'CN');
  assert.equal((await checkClaudeRegion({ fetchImpl: geo('US') })).country, 'CN');
  resetClaudeGuardCache();
  assert.equal((await checkClaudeRegion({ fetchImpl: geo('US') })).country, 'US');
});
