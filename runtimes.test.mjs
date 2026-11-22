/* Guards for the runtime registry. `runtimes.mjs` has no imports and no side
   effects precisely so this file can exist — importing server.mjs would open a
   second dashboard socket.

   Run: npm test */
import assert from 'node:assert/strict';
import { RUNTIMES, DEFAULT_RUNTIME, DEFAULT_EFFORT, runtimeCatalogue, settingsFor, agentIdFromDispatch, bedrockPrefixFor } from './runtimes.mjs';
import { costOf, priceOf, scanCost, stepsCrossed } from './budget.mjs';

let ran = 0;
const test = (name, fn) => { fn(); ran++; console.log('  ok  ' + name); };

// ---------------------------------------------------------------------------

test('the native runtime produces NO settings object', () => {
  // null, not {}. An empty env block still shadows the user's global config,
  // so "no override" and "an override that happens to be empty" must not be
  // the same value here.
  assert.equal(settingsFor(DEFAULT_RUNTIME, { apiKey: 'sk-x' }), null);
});

test('a keyless provider refuses to build settings', () => {
  // The failure has to happen while building, not on the agent's first API
  // request — an agent that dies a minute after dispatch looks like a bug in
  // the prompt, not a missing key.
  assert.throws(() => settingsFor('deepseek', { apiKey: '' }), /no API key/);
});

test('DeepSeek settings carry base URL, Bearer token and model', () => {
  const { env } = settingsFor('deepseek', { apiKey: 'sk-abc', model: 'deepseek-v4-flash' });
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  // AUTH_TOKEN becomes `Authorization: Bearer`; API_KEY becomes `x-api-key`.
  // Verified against a request sink on 2026-08-24 — the wrong one is a 401
  // with no hint as to which of the two names was wrong.
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-abc');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_MODEL, 'deepseek-v4-flash');
});

test('every alias a session can reach is mapped', () => {
  const { env } = settingsFor('deepseek', { apiKey: 'sk-abc' });
  // Subagents and a later `/model sonnet` go through these. An unmapped alias
  // is not an error anywhere — DeepSeek silently maps unknown names to flash,
  // so the session would quietly run on the cheap model and nothing would say so.
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.ok(env[k], `${k} missing`);
    assert.ok(RUNTIMES.deepseek.models.includes(env[k]), `${k}=${env[k]} is not a declared model`);
  }
});

test('an unknown model falls back instead of being passed through', () => {
  const { env } = settingsFor('deepseek', { apiKey: 'sk-abc', model: 'opus' });
  assert.equal(env.ANTHROPIC_MODEL, RUNTIMES.deepseek.models[0]);
});
test('an explicit effort wins over the provider default', () => {
  assert.equal(settingsFor('deepseek', { apiKey: 'k' }).env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  assert.equal(settingsFor('deepseek', { apiKey: 'k', effort: 'low' }).env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
});

test('Claude API settings carry base URL, an apiKeyHelper and no raw key', () => {
  const s = settingsFor('claude-api', { apiKey: 'sk-ant-xyz', keyFile: '/tmp/claude-api.json', model: 'claude-sonnet-5-5' });
  assert.equal(s.env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(s.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
  // The key rides via apiKeyHelper, not via ANTHROPIC_API_KEY: an env key hits
  // Claude Code's approval gate, which a --bg session can never pass, so the
  // OAuth login would silently win. The helper is consulted unconditionally.
  assert.ok(s.apiKeyHelper, 'apiKeyHelper missing');
  assert.equal(s.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, undefined);
  // The raw key must not appear in the settings object — it lives in the key
  // file, read by the helper, so it stays out of argv AND out of this file.
  assert.ok(!JSON.stringify(s).includes('sk-ant-xyz'));
  assert.ok(s.apiKeyHelper.includes('/tmp/claude-api.json'));
});

test('Claude API refuses to build settings without a key-file path', () => {
  assert.throws(() => settingsFor('claude-api', { apiKey: 'sk-ant-xyz' }), /apiKeyHelper/);
});

test('every Claude API alias is mapped to a declared model', () => {
  const { env } = settingsFor('claude-api', { apiKey: 'sk-ant-xyz', keyFile: '/tmp/x.json' });
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.ok(env[k], `${k} missing`);
    assert.ok(RUNTIMES['claude-api'].models.includes(env[k]), `${k}=${env[k]} is not a declared model`);
  }
});

test('the Claude API catalogue entry is ready with a key and marked Anthropic', () => {
  const without = runtimeCatalogue({}).find((r) => r.id === 'claude-api');
  assert.equal(without.ready, false);
  assert.equal(without.anthropicApi, true);
  assert.equal(runtimeCatalogue({ 'claude-api': true }).find((r) => r.id === 'claude-api').ready, true);
});

test('Bedrock settings switch the provider and carry the bearer token', () => {
  const { env } = settingsFor('bedrock', { apiKey: 'ABSK-xyz', model: 'claude-sonnet-5-5', region: 'us-west-2' });
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(env.AWS_REGION, 'us-west-2');
  // The bearer token makes Claude Code skip the AWS credential chain, so a
  // stray ~/.aws profile cannot bill a different account.
  assert.equal(env.AWS_BEARER_TOKEN_BEDROCK, 'ABSK-xyz');
  // Anthropic-format id: Claude Code adds the profile prefix itself (measured
  // against a request sink on 2026-10-27).
  assert.equal(env.ANTHROPIC_MODEL, 'claude-sonnet-5-5');
  // A base URL or an Anthropic key here would send the run to Anthropic's
  // bill instead of AWS's.
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BEDROCK_REGION_PREFIX, undefined);
});

test('Bedrock falls back to the default region and ignores a junk prefix', () => {
  const { env } = settingsFor('bedrock', { apiKey: 'k', region: 'not a region', profilePrefix: 'mars' });
  assert.equal(env.AWS_REGION, RUNTIMES.bedrock.defaultRegion);
  assert.equal(env.ANTHROPIC_BEDROCK_REGION_PREFIX, undefined);
  assert.equal(settingsFor('bedrock', { apiKey: 'k', profilePrefix: 'global' }).env.ANTHROPIC_BEDROCK_REGION_PREFIX, 'global');
});

test('every Bedrock alias is mapped to a declared model', () => {
  const { env } = settingsFor('bedrock', { apiKey: 'k' });
  for (const k of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
    assert.ok(RUNTIMES.bedrock.models.includes(env[k]), `${k}=${env[k]} is not a declared model`);
  }
});

test('Bedrock maps regions to the same profile prefixes Claude Code uses', () => {
  assert.equal(bedrockPrefixFor('us-east-1'), 'us');
  assert.equal(bedrockPrefixFor('eu-west-1'), 'eu');
  assert.equal(bedrockPrefixFor('ap-northeast-1'), 'apac');
  assert.equal(bedrockPrefixFor('us-gov-west-1'), 'us-gov');
  assert.equal(bedrockPrefixFor('ca-central-1'), 'global');
});

test('no retired model name survives in the registry', () => {
  // deepseek-chat and deepseek-reasoner were retired 2026-07-24. This is the
  // guard for the whole CLASS: a dead name fails at the API, hours later, as
  // an agent that will not start — not here, where it is one line to fix.
  const dead = ['deepseek-chat', 'deepseek-reasoner'];
  const all = JSON.stringify(RUNTIMES);
  for (const d of dead) assert.ok(!all.includes(d), `${d} is retired but still in the registry`);
});

test('the catalogue reports readiness and says why not', () => {
  const without = runtimeCatalogue({});
  const ds = without.find((r) => r.id === 'deepseek');
  assert.equal(ds.ready, false);
  assert.match(ds.reason, /apiKey/);
  assert.equal(without.find((r) => r.id === 'claude').ready, true, 'the native runtime never needs a key');
  assert.equal(runtimeCatalogue({ deepseek: true }).find((r) => r.id === 'deepseek').ready, true);
});

test('the catalogue never leaks a key', () => {
  // It is sent to the browser. Nothing secret may be reachable from it. Give
  // every keyed runtime a key so the "No API key" reason (which names the
  // field, not a value) cannot trip the substring check below.
  const haveKey = {};
  for (const r of Object.values(RUNTIMES)) if (r.needsKey) haveKey[r.id] = true;
  assert.ok(!JSON.stringify(runtimeCatalogue(haveKey)).includes('apiKey'));
});

test('the agent id is read back out of a coloured dispatch line', () => {
  const esc = String.fromCharCode(27);
  assert.equal(agentIdFromDispatch(`backgrounded · ${esc}[36mdeadbeef${esc}[39m · my-agent`), 'deadbeef');
  assert.equal(agentIdFromDispatch('backgrounded · deadbeef · name'), 'deadbeef');
  assert.equal(agentIdFromDispatch('something else'), null);
});

test('the default effort is medium on every runtime', () => {
  assert.equal(DEFAULT_EFFORT, 'medium');
  assert.equal(settingsFor('bedrock', { apiKey: 'k' }).env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
  assert.equal(settingsFor('claude-api', { apiKey: 'k', keyFile: '/x' }).env.CLAUDE_CODE_EFFORT_LEVEL, 'medium');
});

test('an exhausted budget greys out the runtime, with the reason', () => {
  const cat = runtimeCatalogue({ bedrock: true }, { bedrock: { limitUsd: 100, spentUsd: 101, pct: 101, exhausted: true } });
  const b = cat.find((r) => r.id === 'bedrock');
  assert.equal(b.ready, false);
  assert.match(b.reason, /Budget exhausted/);
  assert.equal(runtimeCatalogue({ bedrock: true }).find((r) => r.id === 'bedrock').budget, null);
});

test('Bedrock profile ids are priced like the bare model; unknown ones as the dearest', () => {
  assert.equal(priceOf('us.anthropic.claude-sonnet-5-5'), priceOf('claude-sonnet-5-5'));
  assert.equal(priceOf('something-new').out, 50);
  // 1M input + 1M output on Opus 5.5 = $4 + $20
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  // 1h cache write is 2x input, 5m is 1.25x
  assert.equal(costOf('claude-opus-5-5', { cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 } }), 13);
});

test('one message written as several lines is billed once', () => {
  const line = (id, out) => JSON.stringify({ message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 0, output_tokens: out } } });
  const rec = scanCost([line('a', 1e6), line('a', 1e6), line('b', 5e5)].join('\n'), {});
  assert.equal(rec.cost, 30);
  // the next chunk continues message b — only the growth counts
  scanCost(line('b', 1e6), rec);
  assert.equal(rec.cost, 40);
});

test('alert steps: every 10 % crossed, nothing past 100', () => {
  assert.deepEqual(stepsCrossed(18, 41, 10), [20, 30, 40]);
  assert.deepEqual(stepsCrossed(90, 250, 10), [100]);
  assert.deepEqual(stepsCrossed(20, 25, 10), []);
});

// ---------------------------------------------------------------------------
console.log(`\n${ran} checks passed.`);
