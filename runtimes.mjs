/* THE runtime list. It lives alone so a test can import it without server.mjs
   opening a socket, and so the browser can be handed it from /api/meta instead
   of keeping its own copy — two copies of this drift, and a drifted copy is how
   a dropdown offers a model the server will not accept.

   A RUNTIME IS NOT A NEW KIND OF AGENT. It is the same `claude` binary, in the
   same working directory, with the same permissions, pointed at a different
   API. That is the entire design, and it is why nothing here teaches DeepSeek
   how to behave in a repository: CLAUDE.md, hooks, skills, auto-memory and
   the permission rules are read by the HARNESS, not by the
   model. A second mechanism that re-taught a provider those rules would be a
   second truth about them, and the second truth is the one that goes stale.

   Everything a provider needs therefore fits in one env block, which Claude
   Code accepts per invocation via `--settings`. Measured 2026-08-24: that block
   survives `--bg` — a background agent dispatched this way sent its request to
   the configured base URL with the configured token. Env on the spawning
   process is NOT good enough: `claude respawn <id>` re-runs the stored argv, so
   a setting that lives in argv comes back with the agent and a setting that
   lives in the environment does not. */

/** Free of secrets on purpose — the key is read from disk at dispatch time and
 *  never travels to the browser. */
export const RUNTIMES = {
  claude: {
    id: 'claude',
    label: 'Claude',
    /* Aliases, not pinned ids: Claude Code resolves them to the current model,
       and a pinned id here would quietly age. */
    models: ['opus', 'sonnet', 'haiku', 'fable'],
    needsKey: false,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    /* deepseek-chat / deepseek-reasoner retired 2026-07-24. Naming either of
       them here would fail at the API, not in this file, which is the slowest
       possible way to find out. */
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    needsKey: true,
    /* DeepSeek's Anthropic endpoint wants the Bearer form (x-api-key is a 401). */
    bearer: true,
    baseUrl: 'https://api.deepseek.com/anthropic',
    /* What the aliases resolve to once the base URL is DeepSeek's. These are
       not decoration: subagents, the small-fast path and any `/model sonnet`
       typed later all go through them, so leaving them unset would send part of
       a DeepSeek session to a model name DeepSeek maps by guesswork. */
    aliases: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
      CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
    },
    /* DeepSeek v4 carries 1M tokens. Left at the Claude default, Claude Code
       would compact a session that had not filled a fifth of the window. */
    autoCompactWindow: 786432,
  },
  'claude-api': {
    id: 'claude-api',
    label: 'Claude API',
    /* Real model ids, not aliases: ANTHROPIC_MODEL rides to the API verbatim,
       and the API knows ids. Current generation as of 2026-10. */
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    needsKey: true,
    /* The real Anthropic API. Set explicitly so a globally-exported
       ANTHROPIC_BASE_URL left over from a DeepSeek experiment cannot leak into
       an agent the user believes is talking to Anthropic. */
    baseUrl: 'https://api.anthropic.com',
    /* Same four roles the native runtime serves, pinned to the current
       generation so subagents and a later `/model sonnet` land on the same
       family the dropdown shows. */
    aliases: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5',
    },
    /* Marks it as Anthropic's own API for the pane badge: the "not on the
       Anthropic API" warning that guards a DeepSeek answer must not fire here. */
    anthropicApi: true,
  },
  bedrock: {
    id: 'bedrock',
    label: 'Claude · AWS',
    /* Anthropic-format ids, NOT `us.anthropic.…` profile ids. Claude Code maps
       them itself: measured 2026-10-27 against a request sink, ANTHROPIC_MODEL=
       claude-sonnet-5-5 with AWS_REGION set to an EU region went out as
       /model/eu.anthropic.claude-sonnet-5-5/invoke-with-response-stream, after a
       GET /inference-profiles discovery. Hard-coding the prefix here would pin
       every agent to one geography and skip that discovery. */
    models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    needsKey: true,
    /* Not an Anthropic-shaped base URL at all: Bedrock is a provider switch
       (CLAUDE_CODE_USE_BEDROCK) plus AWS auth, so settingsFor builds a
       different env block for it. */
    bedrock: true,
    /* us-east-1 because new Claude models reach the `us.` profiles first. An EU
       region works the same way — set "region" in bedrock.json. */
    defaultRegion: 'us-east-1',
    aliases: {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-5-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
      CLAUDE_CODE_SUBAGENT_MODEL: 'claude-haiku-5-5',
    },
    /* Same Claude models, so the DeepSeek warning must not fire — but it is not
       Anthropic's API either, and the tooltip is where you check whose bill a
       run landed on. */
    note: 'Runs on Amazon Bedrock — a Claude model, billed to your AWS account.',
  },
};

/* Claude Code's own region → profile-prefix table, so the banner can say where
   a request will go. Only a display aid: the request itself is mapped by
   Claude Code. */
export function bedrockPrefixFor(region = '') {
  if (region.startsWith('us-gov-')) return 'us-gov';
  if (region.startsWith('us-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-')) return 'apac';
  return 'global';
}

const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
const PREFIXES = ['us', 'eu', 'apac', 'jp', 'au', 'global'];

export const DEFAULT_RUNTIME = 'claude';

/* What a dispatch runs at when the dropdown says "default" — on every runtime.
   One constant so the env fallback below and the --effort flag the server
   passes cannot drift apart. */
export const DEFAULT_EFFORT = 'medium';

export function runtimeOf(id) {
  return RUNTIMES[id] || RUNTIMES[DEFAULT_RUNTIME];
}

/** What the browser is allowed to know: the list, plus whether each one can
 *  actually start. `reason` exists so a greyed-out option can say why. */
export function runtimeCatalogue(haveKey = {}, budgets = {}) {
  return Object.values(RUNTIMES).map((r) => {
    /* A budget only travels when one is set: { limitUsd, spentUsd, pct, exhausted }. */
    const b = budgets[r.id]?.limitUsd > 0 ? budgets[r.id] : null;
    const keyMissing = r.needsKey && !haveKey[r.id];
    return {
      id: r.id,
      label: r.label,
      models: r.models,
      anthropicApi: r.anthropicApi === true,
      note: r.note || '',
      budget: b ? { limitUsd: b.limitUsd, spentUsd: b.spentUsd, pct: b.pct, exhausted: b.exhausted } : null,
      ready: !keyMissing && !b?.exhausted,
      reason: keyMissing
        ? `No API key — add it to ~/.flotilla/${r.id}.json as "apiKey".`
        : b?.exhausted ? `Budget exhausted ($${b.spentUsd.toFixed(2)} of $${b.limitUsd.toFixed(2)}) — raise the limit in ~/.flotilla/${r.id}-budget.json.` : '',
    };
  });
}

/**
 * The settings object handed to `claude --settings`. Returns null for the
 * native runtime, because "no override" is not the same as "an override that
 * happens to match": an empty env block would still shadow whatever the user
 * has configured globally.
 *
 * `model` is written into ANTHROPIC_MODEL rather than passed as `--model`, so
 * the model choice has exactly one owner. Passing both is how a dropdown ends
 * up describing a session that is running on something else.
 */
export function settingsFor(runtimeId, { apiKey = '', keyFile = '', model = '', effort = '', region = '', profilePrefix = '' } = {}) {
  const r = RUNTIMES[runtimeId];
  if (!r || !r.needsKey) return null;
  if (!apiKey) throw new Error(`${r.label}: no API key`);

  const chosen = r.models.includes(model) ? model : r.models[0];
  if (r.bedrock) return bedrockSettings(r, { apiKey, chosen, effort, region, profilePrefix });
  const settings = {
    env: {
      ANTHROPIC_BASE_URL: r.baseUrl,
      ANTHROPIC_MODEL: chosen,
      ...r.aliases,
    },
  };
  if (r.bearer) {
    /* AUTH_TOKEN becomes `Authorization: Bearer`. No approval gate — it is for
       gateways/proxies, so a --bg agent can take it straight from the env
       block. DeepSeek documents this form for its Anthropic endpoint. */
    settings.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  } else {
    /* x-api-key keys (ANTHROPIC_API_KEY) hit Claude Code's per-key approval
       gate, which a --bg session can never pass: the dialog is skipped in
       background mode, the key is silently dropped, and the OAuth login wins.
       apiKeyHelper is consulted unconditionally, above the login credential,
       and is the documented automation path. It reads the key fresh from the
       key file, so the value stays out of argv AND out of this settings file. */
    if (!keyFile) throw new Error(`${r.label}: apiKeyHelper needs a key file path`);
    settings.apiKeyHelper =
      `node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).apiKey)' ${JSON.stringify(keyFile)}`;
  }
  if (r.autoCompactWindow) settings.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(r.autoCompactWindow);
  /* Only when the caller did not choose one. An explicit effort from the UI
     must win, or the dropdown is lying about the session again. */
  if (!effort) settings.env.CLAUDE_CODE_EFFORT_LEVEL = DEFAULT_EFFORT;
  return settings;
}

/**
 * Bedrock is a provider switch, not a base URL. The key is a Bedrock API key
 * (a bearer token), which Claude Code takes from AWS_BEARER_TOKEN_BEDROCK and
 * then ignores the AWS credential chain entirely — so a stray ~/.aws profile
 * cannot bill a different account. Unlike ANTHROPIC_API_KEY it has no approval
 * gate, so it rides in the env block the way DeepSeek's token does (0600 file).
 *
 * No ANTHROPIC_BASE_URL: with CLAUDE_CODE_USE_BEDROCK the Anthropic base URL is
 * not consulted, and the Bedrock endpoint is derived from AWS_REGION.
 */
function bedrockSettings(r, { apiKey, chosen, effort, region, profilePrefix }) {
  const env = {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: REGION_RE.test(region) ? region : r.defaultRegion,
    AWS_BEARER_TOKEN_BEDROCK: apiKey,
    ANTHROPIC_MODEL: chosen,
    ...r.aliases,
  };
  /* Only when asked: left unset, Claude Code derives the prefix from the region
     and falls back across whatever profiles the account actually has. */
  if (PREFIXES.includes(profilePrefix)) env.ANTHROPIC_BEDROCK_REGION_PREFIX = profilePrefix;
  if (!effort) env.CLAUDE_CODE_EFFORT_LEVEL = DEFAULT_EFFORT;
  return { env };
}

/** `claude --bg` prints `backgrounded · <id> · <name>`, wrapped in colour. The
 *  id is what lets the dashboard remember which runtime an agent was started
 *  on — without it, a bad answer three hours later cannot be attributed. */
export function agentIdFromDispatch(stdout = '') {
  const plain = String(stdout).replace(/\[[0-9;]*m/g, '');
  const m = /backgrounded[^\n]*?\b([0-9a-f]{6,16})\b/i.exec(plain);
  return m ? m[1] : null;
}
