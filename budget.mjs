/* THE BEDROCK BUDGET — what Claude · AWS has cost, and the line it may not cross.

   AWS cannot be asked. The runtime authenticates with a Bedrock API key, a
   bearer token that may call Bedrock and nothing else — Cost Explorer and
   Budgets are out of its reach, and they lag by hours anyway. So the spend is
   computed here, from the same place every other number in this dashboard
   comes from: each assistant message in a transcript carries its own token
   usage. Tokens × list price is the bill, give or take what AWS rounds.

   Deliberately pessimistic: an unknown model is priced as the most expensive
   one, and the default multiplier adds Bedrock's 10 % premium for regional
   (us./eu./apac.) inference profiles. A hard limit that undercounts is not a
   limit; one that stops a few dollars early is merely careful.

   Pure on purpose (no fs, no server) so the arithmetic has a test. */

/* $ per million tokens, Anthropic list prices as of 2026-10. Cache writes are
   1.25× input (5 min) and 2× input (1 h). Haiku 5.5 doubles back to $0.50 /
   $2.50 once a prompt passes 100K tokens — handled in costOf. */
export const PRICES = {
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01 },
};
const WORST = PRICES['claude-fable-5-1'];

export const BUDGET_DEFAULTS = {
  limitUsd: 0,           // 0 = no budget configured: count, never block
  alertStepPct: 10,      // notify at 10, 20, 30 … %
  priceMultiplier: 1.1,  // regional inference profiles cost 10 % more on Bedrock
  spentOffsetUsd: 0,     // spend that happened outside this machine's transcripts
};

/** Bedrock reports `us.anthropic.claude-opus-5-5`, Claude Code may log the
 *  bare id — both are the same price. Longest match first, so a future
 *  `claude-opus-5-5-mini` would not be priced as Opus by accident. */
export function priceOf(model = '') {
  const m = String(model).toLowerCase();
  const key = Object.keys(PRICES).sort((a, b) => b.length - a.length).find((k) => m.includes(k));
  return key ? PRICES[key] : WORST;
}

/** Dollars for one message's usage block. */
export function costOf(model, u = {}, multiplier = 1) {
  if (!u) return 0;
  let p = priceOf(model);
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  // The split is absent in older transcripts; the whole write is then 5 min.
  const w5m = (cc.ephemeral_5m_input_tokens ?? 0) || Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
  const input = u.input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  if (p === PRICES['claude-haiku-5-5'] && input + read + w5m + w1h > 100_000) p = { in: 0.5, out: 2.5, cacheRead: 0.05 };
  const usd = (input * p.in + w5m * p.in * 1.25 + w1h * p.in * 2 + read * p.cacheRead + (u.output_tokens || 0) * p.out) / 1e6;
  return usd * (multiplier || 1);
}

/**
 * Adds the cost in `text` (complete JSONL lines) to `rec` = { cost, lastId,
 * lastCost } and returns rec. Claude Code writes one line per content block,
 * each repeating the message's usage — counting lines would bill a message
 * three times. Lines of one message are adjacent, so it is enough to remember
 * the last id and add only what a later line of it adds on top.
 */
export function scanCost(text, rec, multiplier = 1) {
  rec.cost ||= 0;
  for (const line of String(text).split('\n')) {
    if (!line.includes('"output_tokens"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const m = d.message;
    if (!m?.usage || m.model === '<synthetic>') continue;
    const id = m.id || d.requestId || d.uuid;
    const c = costOf(m.model, m.usage, multiplier);
    if (id && id === rec.lastId) {
      if (c > rec.lastCost) { rec.cost += c - rec.lastCost; rec.lastCost = c; }
    } else {
      rec.cost += c; rec.lastId = id; rec.lastCost = c;
    }
  }
  return rec;
}

/** The alert steps crossed going from `fromPct` to `toPct`, e.g. 18 → 41 at
 *  step 10 gives [20, 30, 40]. Capped at 100: past the limit there is only one
 *  more thing worth saying, and the limit itself says it. */
export function stepsCrossed(fromPct, toPct, step) {
  if (!(step > 0)) return [];
  const out = [];
  for (let s = (Math.floor(fromPct / step) + 1) * step; s <= Math.min(toPct, 100); s += step) out.push(s);
  return out;
}
