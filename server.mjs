/**
 * flotilla — a read-only web dashboard for Claude Code agents.
 *
 * THE ONE ARCHITECTURAL RULE, and the reason this thing cannot drift out of
 * sync with Claude Code:
 *
 *   READING  happens exclusively from files Claude Code itself writes
 *            (~/.claude/jobs/<id>/state.json, ~/.claude/projects/**\/<uuid>.jsonl)
 *            and from `claude agents --json`, its own scripting interface.
 *
 *   WRITING  never touches ~/.claude. Every mutation is one spawn() of the real
 *            `claude` binary with an argv ARRAY — the exact command you would
 *            type yourself. No shell string is ever built, so a prompt can never
 *            become a command. The UI shows you the command it ran.
 *
 *   REPLYING is a real PTY running real `claude attach <id>`. A human types into
 *            it. Nothing is injected programmatically, nothing is screen-scraped.
 *
 * There is no database, no cache of truth, no second model of what an agent is.
 * If this dashboard and Claude Code ever disagree, Claude Code is right and this
 * process has a bug in its *display* — it cannot have caused the disagreement.
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { laneOf } from './lane.mjs';
import { startPush, pushState, setPush, notifyLane, notifyPlain, suggestTopic } from './push.mjs';
import { RUNTIMES, DEFAULT_RUNTIME, DEFAULT_EFFORT, runtimeCatalogue, settingsFor, agentIdFromDispatch, bedrockPrefixFor } from './runtimes.mjs';
import { BUDGET_DEFAULTS, scanCost, stepsCrossed } from './budget.mjs';
import { systemMemory, processMemory, processTable, attachedIds, lastAgentBytes } from './memory.mjs';
import os from 'node:os';
import url from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const JOBS_DIR = path.join(CLAUDE_DIR, 'jobs');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const PUBLIC_DIR = path.join(HERE, 'public');

const PORT = Number(process.env.FLOTILLA_PORT || 4823);
const HOST = '127.0.0.1'; // localhost only, never exposed

// ---------------------------------------------------------------------------
// Locate the real `claude` binary once, so every action runs the same one the
// user runs. Guessing a path here would be the first way to drift.
// ---------------------------------------------------------------------------
let CLAUDE_BIN = null;
async function resolveClaude() {
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(HOME, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  for (const c of candidates) {
    try { await fsp.access(c, fs.constants.X_OK); return c; } catch {}
  }
  return await new Promise((res) => {
    execFile('/bin/sh', ['-lc', 'command -v claude'], (err, out) => {
      res(err ? null : String(out).trim() || null);
    });
  });
}

function runClaude(args, { timeout = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    if (!CLAUDE_BIN) return resolve({ ok: false, stdout: '', stderr: 'claude binary not found', cmd: `claude ${args.join(' ')}` });
    execFile(CLAUDE_BIN, args, { timeout, cwd, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || err?.message || ''),
        cmd: `claude ${args.join(' ')}`,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// READ SIDE — Claude Code's own files are the only source of truth.
// ---------------------------------------------------------------------------

/* Keyed on the file's own mtime: the parse is a pure function of the bytes, so
   an unchanged file cannot produce a different record. Measured: 272 agents were
   read and parsed in full every 1.5 seconds, of which a handful had actually
   moved. */
const jobStateCache = new Map();   // id -> { mtime, size, rec }
async function readJobStates() {
  let entries = [];
  try { entries = await fsp.readdir(JOBS_DIR, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(JOBS_DIR, e.name, 'state.json');
    try {
      const st = await fsp.stat(file);
      const hit = jobStateCache.get(e.name);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) { out.push(hit.rec); continue; }
      const raw = await fsp.readFile(file, 'utf8');
      const d = JSON.parse(raw);
      const rec = {
        id: e.name,
        state: d.state ?? null,
        tempo: d.tempo ?? null,
        detail: d.detail ?? null,
        intent: d.intent ?? null,
        sessionId: d.sessionId ?? null,
        cwd: d.cwd ?? null,
        template: d.template ?? null,
        /* `state: done` with shells still polling in the background is the whole
           reason an agent looked "running" after it had finished. Claude Code
           says so itself in its footer ("2 shells still running"); it was in
           state.json all along and this projection dropped it. */
        /* Only the OPEN ones: a finished shell stays in `fan` with a `doneAt`
           (measured 2026-09-23: 8 of 10 finished agents carried one), and
           counting it put "1 shell running" on agents whose shells had ended
           days ago — and would have kept every one of them from auto-stopping. */
        shells: Array.isArray(d.fan) ? d.fan.filter((f) => f?.kind === 'shell' && !f.doneAt).length : 0,
        inflight: Number(d.inFlight?.tasks) || 0,
        /* Of those tasks, the passive ones: an artifact watch waits for comments
           indefinitely and is not work in progress. */
        monitors: Number(d.inFlight?.drainableMonitors) || 0,
        wakeAt: Number(d.inFlight?.wake?.at) || null,   // a ScheduleWakeup the agent set for itself
        createdAt: d.createdAt ?? null,
        updatedAt: d.updatedAt ?? null,
        output: d.output ?? null,
        /* The settings file an agent respawns with names its runtime. It is
           the fallback for agents agent-runtimes.json never heard of (started
           by hand with --settings, or before the map existed), and the budget
           must not miss one of those. */
        onBedrock: Array.isArray(d.respawnFlags) && d.respawnFlags.some((f) => /(^|\/)bedrock-[^/]*\.settings\.json$/.test(String(f))),
      };
      jobStateCache.set(e.name, { mtime: st.mtimeMs, size: st.size, rec });
      out.push(rec);
    } catch {}
  }
  return out;
}

// `claude agents --json` is authoritative for "is the process alive, is it
// waiting on me". It costs ~0.3s, so it is refreshed on a slower beat than the
// state files, which are free to read.
let agentsCache = { at: 0, list: [] };
let agentsRefresh = null;
/* STALE WHILE REVALIDATE. Spawning `claude agents --json` costs ~0.3s on an idle
   machine — and 25 SECONDS on a loaded one, which is exactly when the dashboard
   is needed most. Measured with eight agents running: `/api/agents` did not
   answer inside 25s and `/api/ui-state` took 3.6s, because every request queued
   behind the same spawn. Nobody waits for it any more: the answer we already
   have goes out immediately and the refresh lands in the background. Only the
   very first call, when there is nothing at all to serve, still waits. */
function refreshAgents() {
  if (agentsRefresh) return agentsRefresh;
  agentsRefresh = runClaude(['agents', '--json', '--all'], { timeout: 25000 })
    .then((r) => {
      if (r.ok) {
        try {
          const list = JSON.parse(r.stdout);
          if (Array.isArray(list)) agentsCache = { at: Date.now(), list };
        } catch {}
      } else {
        agentsCache.at = Date.now();       // don't hammer a failing CLI
      }
    })
    .catch(() => {})
    .finally(() => { agentsRefresh = null; });
  return agentsRefresh;
}
async function readAgentsJson(maxAgeMs = 4000) {
  if (Date.now() - agentsCache.at < maxAgeMs) return agentsCache.list;
  const p = refreshAgents();
  if (agentsCache.at) return agentsCache.list;   // stale is infinitely better than late
  await p;
  return agentsCache.list;
}

function mergeAgents(jobs, live) {
  const byId = new Map();
  const bySession = new Map();

  for (const j of jobs) {
    const rec = { ...j, kind: 'background', pid: null, status: null, waitingFor: null, name: null, alive: false, stateLive: false };
    byId.set(j.id, rec);
    if (j.sessionId) bySession.set(j.sessionId, rec);
  }

  for (const s of live) {
    const key = s.id || null;
    let rec = key ? byId.get(key) : null;
    if (!rec && s.sessionId) rec = bySession.get(s.sessionId);
    if (!rec) {
      rec = {
        id: s.id || null,
        sessionId: s.sessionId || null,
        state: s.state ?? null,
        stateLive: Boolean(s.state),
        tempo: null, detail: null, intent: null,
        cwd: s.cwd ?? null, template: null,
        createdAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
        updatedAt: null, output: null,
        kind: s.kind || 'interactive',
      };
      if (rec.id) byId.set(rec.id, rec);
      else byId.set('sess:' + (rec.sessionId || Math.random()), rec);
    }
    rec.kind = s.kind || rec.kind;
    rec.pid = s.pid ?? null;
    rec.status = s.status ?? null;
    rec.waitingFor = s.waitingFor ?? null;
    rec.name = s.name ?? rec.name;
    rec.alive = Boolean(s.pid);
    if (s.state) { rec.state = s.state; rec.stateLive = true; }
    if (s.sessionId) rec.sessionId = s.sessionId;
    if (s.cwd) rec.cwd = s.cwd;
    if (s.startedAt) rec.startedAt = s.startedAt;
  }

  const list = [...byId.values()];
  // Rank by what a human actually wants to see first: things that need me,
  // then things that are running, then everything else by recency.
  const rank = (a) => {
    if (a.waitingFor || a.status === 'waiting') return 0;
    if (a.stateLive && a.state === 'blocked' && a.alive) return 0;
    if (a.state === 'working' && a.tempo === 'active') return 1;
    if (a.alive && a.state === 'working') return 2;
    if (a.state === 'failed') return 3;
    if (a.state === 'done') return 4;
    return 5;
  };
  list.sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d) return d;
    const ta = Date.parse(a.updatedAt || a.createdAt || 0) || a.startedAt || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || 0) || b.startedAt || 0;
    return tb - ta;
  });
  return list;
}

/**
 * The live pulse is NOT state.json. Measured: a working agent's state.json can
 * sit unchanged for minutes while the agent is busy, because `detail` is only
 * re-summarised occasionally. The transcript file, meanwhile, grows every few
 * seconds and its tail says exactly what is happening right now.
 *
 * So liveness is read from the transcript: its size is the heartbeat, and its
 * last event is the activity.
 */
function activityFromTail(text) {
  let last = null, lastAssistantTool = null, lastSaid = null, model = null, effort = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'assistant' && d.type !== 'user') continue;
    if (d.isMeta) continue;
    last = d;
    if (d.type === 'assistant') {
      // read from Claude Code's own record, so the pane shows what is really in
      // effect rather than what the UI last asked for
      if (d.message?.model) model = d.message.model;
      if (d.effort) effort = d.effort;
      const blocks = d.message?.content || [];
      const tools = blocks.filter((b) => b?.type === 'tool_use').map((b) => b.name);
      lastAssistantTool = tools.length ? tools[tools.length - 1] : null;
      // The brief asks the overview to show the last real output, so you can
      // tell "still moving" from "wedged" without opening the agent.
      const said = blocks.filter((b) => b?.type === 'text' && b.text?.trim()).map((b) => b.text).pop();
      if (said) lastSaid = said.replace(/\s+/g, ' ').trim().slice(0, 240);
    }
  }
  if (!last) return null;
  const at = last.timestamp ? Date.parse(last.timestamp) : null;

  // What the agent is doing follows from which side spoke last.
  let kind = 'thinking', tool = null;
  if (last.type === 'assistant') {
    const blocks = last.message?.content || [];
    if (blocks.some((b) => b?.type === 'tool_use')) { kind = 'tool'; tool = lastAssistantTool; }
    else if (blocks.some((b) => b?.type === 'thinking')) kind = 'thinking';
    else kind = 'writing';
  } else {
    // a tool result just came back — the model is about to think again
    kind = 'thinking';
    tool = lastAssistantTool;
  }
  return { kind, tool, at, said: lastSaid, model, effort };
}

/**
 * When did a human last prompt this agent?
 *
 * Needed because "last change" reorders the working list constantly — every
 * tool call moves a row. "Last input" only moves when YOU do something, which
 * is the order that stays put while you read it.
 *
 * A real prompt is a `user` line that is NOT a tool result, not meta, and not
 * a subagent's turn.
 */
function lastPromptIn(text) {
  let at = null;
  for (const line of text.split('\n')) {
    if (!line.includes('"type":"user"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || d.isMeta || d.isSidechain) continue;
    const c = d.message?.content;
    let real = false;
    if (typeof c === 'string') real = c.trim().length > 0;
    else if (Array.isArray(c)) real = c.some((b) => b?.type === 'text' && b.text?.trim()) && !c.some((b) => b?.type === 'tool_result');
    if (real && d.timestamp) at = Date.parse(d.timestamp) || at;
  }
  return at;
}

/* Model and effort, once seen, stay known. The tail we read for a resting
   agent is short and may contain no assistant message at all — without this the
   value would flicker back to "unknown" and the dropdown would fall back to its
   first option, which looks like a fact and is not one. */
const cfgSeen = new Map(); // sessionId -> { model, effort }

const promptCache = new Map(); // sessionId -> { at, retryAt }
const PROMPT_WINDOW = 6 * 1024 * 1024;

/**
 * The deep scan runs ONCE per session, never on a size change: a working
 * agent's transcript grows every few seconds, so re-scanning on growth would
 * mean re-reading 6 MB on every tick. New prompts arrive through the 64 KB
 * tail that enrichLive already reads.
 */
async function findLastPrompt(file, sessionId, size) {
  const hit = promptCache.get(sessionId);
  if (hit && (hit.at !== null || Date.now() < hit.retryAt)) return hit.at;
  // One bounded window, read whole — chunked backwards reading would drop the
  // line straddling each chunk boundary and silently report an older prompt.
  const { text } = await readTail(file, PROMPT_WINDOW);
  const at = lastPromptIn(text);
  // Nothing found inside the window on a file bigger than it: the prompt is
  // further back than we look. Retry rarely instead of caching a wrong null.
  promptCache.set(sessionId, { at, retryAt: Date.now() + (at === null && size > PROMPT_WINDOW ? 60000 : 3600000) });
  return at;
}

/* THE ONE THAT MATTERED. Everything below is derived from the bytes of one
   file, so an unchanged file cannot yield a different answer — the whole block
   is memoised on (mtime, size, busy).

   Measured before: every 1.5 seconds the server read and parsed the tail of
   EVERY transcript — 272 agents × 24–64 KB ≈ 6.5 MB read and regex-scanned per
   tick, about 4 MB/s, forever, whether or not anything had moved. With eight
   agents actually running, eight files change per tick and the other 264 reads
   were pure waste. On an idle machine it kept up; at load 62 the event loop
   never caught up and the page went with it. */
const tailCache = new Map();   // sessionId -> { key, data }

/* A FEW AT A TIME, never all at once. On a cold start every agent's caches are
   empty, so every one of them reads up to PROMPT_WINDOW (6 MB) of transcript —
   and `Promise.all` did that for ALL of them in the same tick. Measured
   2026-09-01: 519 agents, 76 transcripts over 8 MB, one of 180 MB; each read is
   a 6 MB buffer plus its UTF-16 string plus the split lines, ≈30 MB apiece,
   all alive together → 4 GB heap → "Reached heap limit" 115 s after boot, on
   two restarts in a row. The 2.5-day-old server only survived because it had
   booted when the fleet was half the size. The fix is a pool, not a bigger heap:
   8 in flight is ~240 MB peak, and the warm path (cache hit, one stat) is not
   slower for it. */
const TAIL_POOL = 8;

/* A STALLED AGENT LOOKS LIKE A RESTING ONE, AND IT IS NOT.
   Observed in practice: an agent's turn ended by announcing its next step,
   its Monitor finished two minutes later and the notification was
   written to the transcript as a queue-operation `enqueue` - and never
   dequeued. The process stayed alive, the daemon said status:idle and
   state:working, and the lane rule filed that as Ready. No summary ever came,
   because nothing would ever wake it again. The tell is in the transcript: an
   enqueue that nothing came after. Returns its time, or null. */
const STALL_MS = 3 * 60 * 1000;
function stalledSince(text) {
  let pending = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'queue-operation') {
      pending = d.operation === 'enqueue' ? (Date.parse(d.timestamp) || null) : null;
    } else if (d.type === 'assistant' || d.type === 'user') pending = null;
  }
  return pending;
}
async function forEachPooled(items, limit, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
async function enrichLive(list) {
  await forEachPooled(list, TAIL_POOL, async (a) => {
    if (!a.sessionId) return;
    const file = await findTranscript(a.sessionId);
    if (!file) return;
    let st;
    try {
      st = await fsp.stat(file);
      a.tsize = st.size;
      a.tmtime = st.mtimeMs;
    } catch { return; }

    // Reading the tail is only worth it for agents that are actually moving —
    // except that model/effort should be visible on a resting agent too, and
    // those come from the same read.
    const busy = a.alive && (a.state === 'working' || a.status === 'busy');
    /* `busy` is part of the key, not just the file: it decides how much of the
       tail is read and whether `activity` is derived at all, and it can flip
       without the file moving (the daemon's status changes on its own). */
    const key = `${st.mtimeMs}:${st.size}:${busy ? 1 : 0}`;
    const hit = tailCache.get(a.sessionId);
    if (hit && hit.key === key) {
      for (const [k, v] of Object.entries(hit.data)) if (v !== undefined) a[k] = v;
      return;
    }
    try { a.lastPromptAt = await findLastPrompt(file, a.sessionId, a.tsize); } catch {}
    const keep = () => tailCache.set(a.sessionId, { key, data: {
      lastPromptAt: a.lastPromptAt, model: a.model, effort: a.effort, activity: a.activity,
      waitingFor: a.waitingFor,
    } });
    try {
      const { text } = await readTail(file, busy ? 64 * 1024 : 24 * 1024);
      const act = activityFromTail(text);
      const seen = cfgSeen.get(a.sessionId) || {};
      if (act?.model) seen.model = act.model;
      if (act?.effort) seen.effort = act.effort;
      if (seen.model || seen.effort) cfgSeen.set(a.sessionId, seen);
      a.model = seen.model || null;
      a.effort = seen.effort || null;
      if (!a.waitingFor && a.alive && a.status === 'idle' && a.state === 'working') {
        const since = stalledSince(text);
        if (since && Date.now() - since > STALL_MS) {
          a.waitingFor = 'stalled: a background result arrived but never woke it. Reply to nudge it.';
        }
      }
      if (!busy) { keep(); return; }
      if (act) a.activity = act;
      // A prompt that arrived since the deep scan shows up here for free.
      const fresh = lastPromptIn(text);
      if (fresh && (!a.lastPromptAt || fresh > a.lastPromptAt)) {
        a.lastPromptAt = fresh;
        promptCache.set(a.sessionId, { at: fresh, scanned: a.tsize });
      }
      keep();
    } catch {}
  });
  return list;
}

/* ONE SNAPSHOT AT A TIME, SHARED BY EVERYONE WHO ASKS.

   Six call sites want the fleet, and one of them is a 1.5-second interval that
   does not wait for the previous one to come back. While the caches are warm
   that is free — a snapshot costs a few milliseconds. Cold it is not: every
   transcript has to be found and scanned once, which on this fleet is hundreds
   of files and gigabytes, and the caches only fill when a scan FINISHES. So a
   cold start with a browser attached stacked a fresh full scan on top of the
   running one every 1.5 seconds, forty of them all repeating the same work and
   all competing for the same disk. Measured 2026-09-13 at load 35: twelve
   minutes after the restart, not one snapshot had completed — the dashboard
   never came back, and `/api/agents` answered nothing at all.

   Whoever asks while one is in flight gets that one. It is at most 1.5 seconds
   older than a brand new one, which is the age the feed ships anyway. */
let snapInFlight = null;
function snapshot() {
  if (snapInFlight) return snapInFlight;
  snapInFlight = buildSnapshot().finally(() => { snapInFlight = null; });
  return snapInFlight;
}
async function buildSnapshot() {
  const [jobs, live] = await Promise.all([readJobStates(), readAgentsJson()]);
  const list = await trackLanes(await enrichLive(mergeAgents(jobs, live)));
  /* Stamped here rather than merged in: the runtime is a property of how the
     agent was STARTED, and nothing the daemon reports later can revise it. */
  const map = await getRuntimeMap();
  for (const a of list) a.runtime = (a.id && map[a.id]) || (a.onBedrock ? 'bedrock' : DEFAULT_RUNTIME);
  return list;
}

// ---------------------------------------------------------------------------
// Transcript. Found by SEARCHING for the session file rather than computing the
// encoded project-dir name — an encoding rule is an assumption that can rot.
// ---------------------------------------------------------------------------
const transcriptPathCache = new Map();
const transcriptMissCache = new Map(); // sessionId -> retry-after timestamp

async function findTranscript(sessionId) {
  if (!/^[0-9a-fA-F-]{8,64}$/.test(sessionId)) return null;
  const hit = transcriptPathCache.get(sessionId);
  if (hit) { try { await fsp.access(hit); return hit; } catch { transcriptPathCache.delete(sessionId); } }
  // Without this, an agent that has no transcript yet would rescan every
  // project directory on every 1.5s snapshot.
  const miss = transcriptMissCache.get(sessionId);
  if (miss && Date.now() < miss) return null;
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(PROJECTS_DIR, d.name, `${sessionId}.jsonl`);
    try { await fsp.access(p); transcriptPathCache.set(sessionId, p); return p; } catch {}
  }
  transcriptMissCache.set(sessionId, Date.now() + 20000);
  return null;
}

/** Read a byte range [from, EOF) and stop at the last complete line. */
async function readFrom(file, from) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (from >= size) return { text: '', offset: size, size };
    const len = size - from;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, from);
    const text = buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    if (cut < 0) return { text: '', offset: from, size };
    return { text: text.slice(0, cut + 1), offset: from + Buffer.byteLength(text.slice(0, cut + 1)), size };
  } finally {
    await fh.close();
  }
}

/** Read at most `maxBytes` from the END of a file, dropping a partial first line. */
async function readTail(file, maxBytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    await fh.read(buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, truncated: start > 0, size };
  } finally {
    await fh.close();
  }
}

/* Claude Code's own bookkeeping. `attachment` records are its internal context
   notes (which skills loaded, which MCP servers, a file-change summary) — they
   were rendering as a bare "[attachment]" line that said nothing, and Claude's
   own view does not show them either. */
const SKIP_TYPES = new Set([
  'agent-setting', 'mode', 'permission-mode', 'queue-operation',
  'file-history-snapshot', 'file-history-delta', 'last-prompt',
  'ai-title', 'agent-name', 'attachment',
]);

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('');
  }
  return '';
}

function clip(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s ?? null);
  if (s == null) return '';
  return s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more characters]` : s;
}

/* Which user lines are YOURS.
   A `user` line in the transcript is not the same thing as "something you
   typed": tool results, injected reminders and the stdout of a local command
   all ride on the user role. The prompt jumper and the "you" styling must land
   only on real turns, so the decision is made ONCE, here, and shipped as a
   flag — two consumers guessing separately is how they drift apart. */
const INJECTED_ONLY = /^\s*<(local-command-stdout|command-name|command-message|command-args|user-memory-input)\b/;
function looksTyped(said) {
  const bare = said.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!bare) return false;                    // nothing but an injected reminder
  return !INJECTED_ONLY.test(bare);
}

/* Two tool calls are not plumbing — they are the agent handing the turn back.
   A question and a plan-for-approval are the only things in a transcript that
   BLOCK, and rendering them as the 385th grey "tool call" row is how they get
   missed. The shape is pulled apart here rather than in the browser for the
   same reason `prompt` is: one decision, shipped as data, so the renderer and
   the filter cannot disagree about what counts as important. */
function parseAsk(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  const out = qs.slice(0, 4).map((q) => ({
    q: String(q?.question || '').slice(0, 800),
    header: String(q?.header || '').slice(0, 40),
    multi: Boolean(q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 8).map((o) => ({
      label: String(o?.label || '').slice(0, 240),
      desc: String(o?.description || '').slice(0, 900),
    })),
  }));
  return out.length ? out : null;
}

function parseTranscript(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;
    if (SKIP_TYPES.has(t)) continue;

    if (t === 'user') {
      if (d.isMeta) continue;
      const c = d.message?.content;
      const blocks = [];
      if (typeof c === 'string') {
        if (c.trim()) blocks.push({ t: 'text', text: c });
      } else if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'text' && b.text?.trim()) blocks.push({ t: 'text', text: b.text });
          else if (b?.type === 'tool_result') {
            blocks.push({
              t: 'tool_result',
              isError: Boolean(b.is_error),
              // The id travels so the browser can pair a result with its call
              // even when a delta read splits the two across two responses.
              forId: b.tool_use_id || null,
              text: clip(textOf(b.content) || JSON.stringify(b.content ?? ''), 4000),
            });
          } else if (b?.type === 'image') blocks.push({ t: 'image' });
        }
      }
      if (!blocks.length) continue;
      const said = blocks.filter((b) => b.t === 'text').map((b) => b.text).join('\n');
      // A compaction carry-over rides on the user role and is the longest
      // "user message" in any transcript — thousands of words that you never
      // wrote. Claude Code flags it itself (`isCompactSummary`), so this is a
      // structural fact, not a string match on a sentence that may change.
      if (d.isCompactSummary) {
        events.push({ role: 'summary', uuid: d.uuid || null, ts: d.timestamp || null, blocks: [{ t: 'text', text: said }] });
        continue;
      }
      const prompt = !d.isSidechain && !!said && looksTyped(said);
      events.push({ role: 'user', uuid: d.uuid || null, ts: d.timestamp || null, sidechain: !!d.isSidechain, prompt, blocks });
    } else if (t === 'assistant') {
      const m = d.message || {};
      const blocks = [];
      for (const b of m.content || []) {
        if (b?.type === 'text' && b.text?.trim()) blocks.push({ t: 'text', text: b.text });
        else if (b?.type === 'thinking' && b.thinking?.trim()) blocks.push({ t: 'thinking', text: b.thinking });
        else if (b?.type === 'tool_use') {
          const name = b.name || 'tool';
          const blk = { t: 'tool_use', id: b.id || null, name, input: clip(JSON.stringify(b.input ?? {}, null, 1), 2500) };
          if (name === 'AskUserQuestion') blk.ask = parseAsk(b.input);
          else if (name === 'ExitPlanMode') blk.plan = String(b.input?.plan || '').slice(0, 20000) || null;
          blocks.push(blk);
        }
      }
      if (!blocks.length) continue;
      const u = m.usage || {};
      events.push({
        role: 'assistant',
        // The transcript line's own id. The browser dedupes on it: two reads
        // that overlap (a tail racing a tail) must not draw the line twice.
        uuid: d.uuid || null,
        ts: d.timestamp || null,
        sidechain: !!d.isSidechain,
        model: m.model || null,
        usage: { in: u.input_tokens ?? 0, out: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
        blocks,
      });
    } else if (t === 'system') {
      // Only if it actually says something. Falling back to `subtype` printed
      // bare labels like "stop_hook_summary" and "turn_duration" as if they
      // were messages.
      const s = clip(d.content || '', 1200).trim();
      if (s) events.push({ role: 'system', uuid: d.uuid || null, ts: d.timestamp || null, blocks: [{ t: 'text', text: s }] });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Our own data dir. This is the ONLY place this program writes, and it is
// deliberately outside ~/.claude so the read-only guarantee toward Claude Code
// stays a property of the layout, not of my care.
// ---------------------------------------------------------------------------
/* FLOTILLA_DATA_DIR exists for exactly one case: a second instance on another
   port, to try a change while the real one keeps running. Sharing this dir
   would make two servers overwrite each other's read/archive state and answer
   the same phone reply twice. */
const DATA_DIR = process.env.FLOTILLA_DATA_DIR || path.join(HOME, '.flotilla');
const DRAFTS_FILE = path.join(DATA_DIR, 'drafts.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage-index.json');

async function ensureDataDir() { try { await fsp.mkdir(DATA_DIR, { recursive: true }); } catch {} }

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}
/** Write via temp + rename so a crash mid-write cannot truncate the drafts. */
async function writeJsonAtomic(file, obj) {
  await ensureDataDir();
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  await fsp.rename(tmp, file);
}

const UI_FILE = path.join(DATA_DIR, 'ui-state.json');

// ---------------------------------------------------------------------------
// RUNTIMES — the same binary, a different API.
//
// A runtime override is one env block, handed to `claude --settings <file>`.
// A FILE, not inline JSON: an API key in argv is readable by every process on
// the machine via `ps`, and the daemon replays the argv on `claude respawn`,
// so the path has to keep working long after the dispatch.
// ---------------------------------------------------------------------------
const RUN_DIR = path.join(DATA_DIR, 'run');
const RUNTIME_MAP_FILE = path.join(DATA_DIR, 'agent-runtimes.json');

/** The one place a key lives. Env wins so a shell can override without editing
 *  a file, which is what you want while you are still testing the key. */
async function runtimeKey(id) {
  const fromEnv = process.env[`${id.toUpperCase()}_API_KEY`];
  if (fromEnv) return String(fromEnv).trim();
  const cfg = await readJson(path.join(DATA_DIR, `${id}.json`), null);
  return String(cfg?.apiKey || '').trim();
}

async function runtimeKeys() {
  const out = {};
  for (const r of Object.values(RUNTIMES)) if (r.needsKey) out[r.id] = Boolean(await runtimeKey(r.id));
  return out;
}

/** Deterministic content per (runtime, model) so two dispatches racing on the
 *  same file cannot write different bytes. 0600 because it holds the key. */
async function settingsFileFor(runtimeId, { model, effort }) {
  const keyFile = path.join(DATA_DIR, `${runtimeId}.json`);
  /* Bedrock also needs a region (and optionally a profile prefix); both live
     next to the key so one file is the whole setup. */
  const cfg = await readJson(keyFile, null);
  const settings = settingsFor(runtimeId, {
    apiKey: await runtimeKey(runtimeId),
    keyFile,
    model,
    effort,
    region: String(cfg?.region || '').trim(),
    profilePrefix: String(cfg?.profilePrefix || '').trim(),
  });
  if (!settings) return null;
  await fsp.mkdir(RUN_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(RUN_DIR, `${runtimeId}-${model || 'default'}.settings.json`);
  await fsp.writeFile(file, JSON.stringify(settings, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.chmod(file, 0o600);
  return file;
}

/* Which agent ran on what. Without this a weak answer three hours later cannot
   be attributed to a provider, and the whole point of having two is comparing
   them. Keyed by agent id, which is what survives a respawn. */
let runtimeMap = null;
async function getRuntimeMap() {
  if (!runtimeMap) runtimeMap = await readJson(RUNTIME_MAP_FILE, {});
  return runtimeMap;
}
async function noteRuntime(agentId, runtimeId) {
  if (!agentId || runtimeId === DEFAULT_RUNTIME) return;
  const map = await getRuntimeMap();
  map[agentId] = runtimeId;
  await writeJsonAtomic(RUNTIME_MAP_FILE, map);
}

// ---------------------------------------------------------------------------
// BEDROCK BUDGET — a hard ceiling on what Claude · AWS may cost.
//
// Spend is computed from the transcripts of every agent that ran on Bedrock
// (see budget.mjs for why, and why it errs high). Every BUDGET_TICK the total
// is refreshed; each alert step crossed (10 %, 20 % …) is announced once, by
// macOS notification and by ntfy if push is on. At 100 % three things happen,
// because any one alone leaks:
//   1. new Bedrock dispatches and respawns are refused,
//   2. every living Bedrock agent is stopped,
//   3. the token in run/bedrock-*.settings.json is replaced with a dead one, so
//      an agent resumed by attach or `claude respawn` fails at AWS instead of
//      spending. A dead token, not an empty one: with AWS_BEARER_TOKEN_BEDROCK
//      unset, Claude Code would fall back to ~/.aws and bill whatever profile
//      it finds there.
// Raising limitUsd (or the budget file going away) undoes 1 and 3 on the next
// tick. It is still an estimate, refreshed every 30 s — a turn already in
// flight when the line is crossed finishes, so expect to overshoot by cents.
// ---------------------------------------------------------------------------
const BUDGET_FILE = path.join(DATA_DIR, 'bedrock-budget.json');
const BUDGET_STATE_FILE = path.join(DATA_DIR, 'bedrock-budget-state.json');
const BUDGET_TICK = 30000;
const DEAD_TOKEN = 'BUDGET-EXHAUSTED-flotilla';

let budgetState = null;   // { files: {path: {offset, cost, lastId, lastCost}}, notifiedPct, exhaustedAt }
let budgetView = null;    // last computed summary, what the browser sees
let budgetRun = null;     // the refresh in flight; a second caller waits for it instead of reading stale numbers

async function budgetConfig() {
  const cfg = { ...BUDGET_DEFAULTS, ...(await readJson(BUDGET_FILE, {}) || {}) };
  for (const k of Object.keys(BUDGET_DEFAULTS)) cfg[k] = Math.max(0, Number(cfg[k]) || 0);
  if (!cfg.priceMultiplier) cfg.priceMultiplier = 1;
  return cfg;
}

/** Every transcript a Bedrock agent wrote: the main session plus its
 *  subagents. Sessions are remembered in the state file, so a respawn that
 *  moves an agent to a new session never drops what the old one cost. */
async function bedrockTranscripts(list) {
  const out = new Set(Object.keys(budgetState.files));
  for (const a of list) {
    if (a.runtime !== 'bedrock' || !a.sessionId) continue;
    const main = await findTranscript(a.sessionId);
    if (!main) continue;
    out.add(main);
    const subDir = path.join(main.slice(0, -'.jsonl'.length), 'subagents');
    try {
      for (const f of await fsp.readdir(subDir)) if (f.endsWith('.jsonl')) out.add(path.join(subDir, f));
    } catch {}
  }
  return [...out];
}

async function budgetAlert(title, message, priority) {
  console.log(`  BUDGET      ${title} — ${message}`);
  execFile('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)} sound name "Glass"`], () => {});
  notifyPlain(title, message, { priority }).catch(() => {});   // throws when push is off — macOS already has it
}

/** Puts the real key back into, or a dead one into, every Bedrock settings
 *  file. Only files that already exist: a missing one is written at dispatch. */
async function setBedrockRunToken(token) {
  let names = [];
  try { names = (await fsp.readdir(RUN_DIR)).filter((n) => /^bedrock-.*\.settings\.json$/.test(n)); } catch { return; }
  for (const n of names) {
    const file = path.join(RUN_DIR, n);
    const cfg = await readJson(file, null);
    if (!cfg?.env || cfg.env.AWS_BEARER_TOKEN_BEDROCK === token) continue;
    cfg.env.AWS_BEARER_TOKEN_BEDROCK = token;
    await fsp.writeFile(file, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}

const usd = (n) => '$' + n.toFixed(2);

function refreshBedrockBudget() {
  budgetRun ||= budgetRefresh().finally(() => { budgetRun = null; });
  return budgetRun;
}

async function budgetRefresh() {
  budgetState ||= { files: {}, notifiedPct: 0, exhaustedAt: null, ...(await readJson(BUDGET_STATE_FILE, {}) || {}) };
  const cfg = await budgetConfig();
  let changed = false;
  for (const file of await bedrockTranscripts(await snapshot())) {
    const rec = (budgetState.files[file] ||= { offset: 0, cost: 0 });
    let st; try { st = await fsp.stat(file); } catch { continue; }   // deleted: its cost stays counted
    if (st.size <= rec.offset) continue;
    const { text, offset } = await readFrom(file, rec.offset);
    if (!text) continue;
    scanCost(text, rec, cfg.priceMultiplier);
    rec.offset = offset;
    changed = true;
  }
  const spent = cfg.spentOffsetUsd + Object.values(budgetState.files).reduce((t, r) => t + (r.cost || 0), 0);
  const limit = cfg.limitUsd;
  const pct = limit > 0 ? (spent / limit) * 100 : 0;
  const exhausted = limit > 0 && spent >= limit;

  if (limit > 0) {
    const crossed = stepsCrossed(budgetState.notifiedPct || 0, pct, cfg.alertStepPct);
    const top = crossed.at(-1);
    if (top && top < 100) {
      await budgetAlert(`Claude · AWS: ${top} % of budget`, `${usd(spent)} of ${usd(limit)} spent (${pct.toFixed(1)} %).`, top >= 80 ? 4 : 3);
    }
    if (top) { budgetState.notifiedPct = top; changed = true; }
    // Limit raised: alerts for the new range fire again from where we are now.
    if (pct < (budgetState.notifiedPct || 0) - cfg.alertStepPct) {
      budgetState.notifiedPct = Math.floor(pct / cfg.alertStepPct) * cfg.alertStepPct; changed = true;
    }
  }

  if (exhausted) {
    if (!budgetState.exhaustedAt) {
      budgetState.exhaustedAt = Date.now(); changed = true;
      await budgetAlert('Claude · AWS: budget exhausted', `${usd(spent)} of ${usd(limit)} — Bedrock agents are being stopped, new starts are blocked.`, 5);
    }
    await setBedrockRunToken(DEAD_TOKEN);
    if (CLAUDE_BIN) {
      for (const a of await snapshot()) {
        if (a.runtime !== 'bedrock' || !a.alive || !a.id || !SHORT_ID.test(a.id)) continue;
        const r = await runClaude(['stop', a.id]);
        console.log(`  BUDGET      stop ${a.id} ${r.ok ? 'ok' : r.stderr.trim()}`);
      }
      agentsCache.at = 0;
    }
  } else if (budgetState.exhaustedAt) {
    budgetState.exhaustedAt = null; changed = true;
    const key = await runtimeKey('bedrock');
    if (key) await setBedrockRunToken(key);
    console.log(`  BUDGET      available again: ${usd(spent)} of ${usd(limit)}`);
  }

  if (changed) await writeJsonAtomic(BUDGET_STATE_FILE, budgetState);
  budgetView = { limitUsd: limit, spentUsd: spent, pct, exhausted, alertStepPct: cfg.alertStepPct, priceMultiplier: cfg.priceMultiplier, at: Date.now() };
  return budgetView;
}

/** The gate every Bedrock start goes through. Fresh numbers, not the last
 *  tick's: the click that would cross the line is exactly the one to catch. */
async function bedrockBlocked() {
  const b = await refreshBedrockBudget().catch(() => budgetView);
  return b?.exhausted ? `Claude · AWS: budget exhausted (${usd(b.spentUsd)} of ${usd(b.limitUsd)}). Raise the limit in ~/.flotilla/bedrock-budget.json.` : null;
}

// ---------------------------------------------------------------------------
// Read / archive state. Deliberately tracked HERE and not in the browser: an
// agent that finishes while the dashboard is closed must still be unread when
// you next open it, exactly like mail. The browser cannot observe that.
// ---------------------------------------------------------------------------
/* A state file that exists but does not parse is NOT an empty state. Reading
   it as `{}` and saving 400 ms later would overwrite the only copy of every
   workspace, draft and unread mark with nothing. The unreadable bytes are
   kept beside it first, so there is always something to recover from. */
async function readJsonKeep(file, fallback) {
  let raw;
  try { raw = await fsp.readFile(file, 'utf8'); } catch { return fallback; }   // missing: a fresh install
  try { return JSON.parse(raw); } catch {
    const keep = `${file}.unreadable-${Date.now()}`;
    await fsp.writeFile(keep, raw).catch(() => {});
    console.log(`  WARNING     ${path.basename(file)} unreadable — kept as ${path.basename(keep)}`);
    return fallback;
  }
}

/* The promise is cached, not the object: two requests arriving before the
   first read finished used to read the file twice and each install its own
   object — whatever the first one changed in between was silently dropped. */
let ui = null, uiLoading = null;
async function getUi() {
  if (ui) return ui;
  uiLoading ||= (async () => {
    const u = await readJsonKeep(UI_FILE, null) || {};
    u.unread ||= {};     // key -> {at, lane}
    u.archived ||= {};   // key -> at
    u.pinned ||= {};     // key -> at   ("keep this one in sight", see /api/pin)
    u.lanes ||= {};      // key -> last seen lane
    u.laneAt ||= {};     // key -> when that lane was entered (the "finished at" clock)
    u.prefs ||= {};
    u.workspaces ||= {}; // name -> { cols:[{w,panes:[{key,h}]}] }   (the desk of one window)
    u.wsInfo ||= {};     // name -> { root, title, createdAt, usedAt, hidden, allFolders }   (see WORKSPACES)
    u.laneRule ??= 0;    // which version of the lane rule wrote ui.lanes (see LANE_RULE)
    u.autoStopped ||= {}; // key -> {at, lane, bytes}   (see AUTO-STOP)
    /* Beside prefs, not in them: the browser posts its WHOLE prefs object on
       every change, so a window opened before you moved the auto-stop setting
       would quietly write the old value back the next time you sorted a list. */
    u.autoStop ||= { min: AUTO_STOP_DEFAULT_MIN, waiting: true };
    ui = u;
    if (migrateWorkspaces(u)) saveUi();
    return u;
  })();
  return uiLoading;
}

// ---------------------------------------------------------------------------
// WORKSPACES — one window, one folder.
//
// A workspace is a desk (`ui.workspaces[name]`, the pane layout, unchanged
// since before this existed) plus the folder it is ABOUT (`ui.wsInfo[name]`).
// The folder decides three things in that window: which agents the list shows,
// where a new agent starts, and which ones "mark all read" touches. Everything
// else — drafts, unread, pins, archive — belongs to the AGENT, and an agent
// belongs to exactly one folder, so it needs no second copy per workspace.
//
// Nothing here ever deletes a workspace. "Hide" takes it out of the list and
// out of "open all"; the desk and its folder stay in the file.
// ---------------------------------------------------------------------------
const underRoot = (cwd, root) => !root || !cwd || cwd === root || String(cwd).startsWith(root.endsWith('/') ? root : root + '/');

/** Where a workspace points when nobody said: FLOTILLA_DEFAULT_ROOT, else the
 *  folder the existing desks have been composing new agents in all along. */
function defaultRoot(u) {
  if (process.env.FLOTILLA_DEFAULT_ROOT) return path.resolve(process.env.FLOTILLA_DEFAULT_ROOT);
  if (u.wsInfo?.main?.root) return u.wsInfo.main.root;
  const n = new Map();
  for (const lay of Object.values(u.workspaces || {}))
    for (const c of lay?.cols || []) for (const p of c.panes || [])
      if (p.compose?.cwd) n.set(p.compose.cwd, (n.get(p.compose.cwd) || 0) + 1);
  let best = '', bestN = 0;
  for (const [k, v] of n) if (v > bestN) { best = k; bestN = v; }
  return best || HOME;
}
/** Every desk that exists gets a folder, once. Returns whether it wrote.
 *  The desks from before workspaces were numbered extra windows of the SAME
 *  folder (e.g. "w2" or "w3"). They are kept
 *  whole but start hidden: listed under "hidden", never offered by "open all",
 *  back with one click — "main" is the desk this all grew out of. */
function migrateWorkspaces(u) {
  let changed = false;
  const root = defaultRoot(u);
  const first = !Object.keys(u.wsInfo).length;
  for (const name of new Set(['main', ...Object.keys(u.workspaces)])) {
    if (u.wsInfo[name]) continue;
    u.wsInfo[name] = { root, title: '', createdAt: Date.now(), usedAt: 0, ...(first && name !== 'main' ? { hidden: true } : {}) };
    changed = true;
  }
  return changed;
}
/** A URL can name a workspace that was never created (an old `?ws=w7` tab).
 *  It gets the main folder rather than an error — the tab is already open. */
function ensureWs(u, name) {
  if (!u.wsInfo[name]) {
    u.wsInfo[name] = { root: u.wsInfo.main?.root || defaultRoot(u), title: '', createdAt: Date.now(), usedAt: Date.now() };
    saveUi();
  }
  return u.wsInfo[name];
}
function newWsName(u, root) {
  const base = (path.basename(root) || 'ws').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'ws';
  let name = base, n = 2;
  while (name === 'main' || u.wsInfo[name] || u.workspaces[name]) name = `${base}-${n++}`;
  return name;
}
async function checkRoot(raw) {
  let r = String(raw || '').trim();
  if (!r) return { error: 'No folder given.' };
  if (r === '~' || r.startsWith('~/')) r = path.join(HOME, r.slice(1));
  if (!path.isAbsolute(r)) return { error: 'Please give an absolute path (/… or ~/…).' };
  r = path.resolve(r);
  try { if (!(await fsp.stat(r)).isDirectory()) return { error: 'Not a folder: ' + r }; }
  catch { return { error: 'No such folder: ' + r }; }
  return { root: r };
}
/* "Which repo is this agent in" — the innermost folder with a `.git`, else the
   folder itself. Only used to SUGGEST folders for a new workspace. */
const repoRootCache = new Map();
function repoRootOf(dir) {
  if (repoRootCache.has(dir)) return repoRootCache.get(dir);
  let found = dir;
  for (let d = dir, i = 0; d && d !== path.dirname(d) && i < 40; d = path.dirname(d), i++) {
    if (fs.existsSync(path.join(d, '.git'))) { found = d; break; }
  }
  repoRootCache.set(dir, found);
  return found;
}

// ---------------------------------------------------------------------------
// SNAPSHOTS. Atomic writes protect against a crash mid-write; they do not
// protect against a bug that writes the wrong thing. So the two files that
// hold everything you typed and arranged are copied aside every hour (kept
// 3 days) and every day (kept 60 days). ~300 KB a copy.
// ---------------------------------------------------------------------------
const SNAP_DIR = path.join(DATA_DIR, 'backups', 'auto');
async function snapshotState() {
  const pad = (x) => String(x).padStart(2, '0');
  const d = new Date();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  for (const [tier, stamp, keep] of [['hourly', `${day}_${pad(d.getHours())}`, 72], ['daily', day, 60]]) {
    try {
      const base = path.join(SNAP_DIR, tier), dir = path.join(base, stamp);
      await fsp.mkdir(dir, { recursive: true });
      for (const f of [UI_FILE, DRAFTS_FILE]) await fsp.copyFile(f, path.join(dir, path.basename(f))).catch(() => {});
      const all = (await fsp.readdir(base)).filter((x) => /^\d{4}-\d\d-\d\d/.test(x)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - keep))) await fsp.rm(path.join(base, old), { recursive: true, force: true });
    } catch {}
  }
}
let uiFlush = null;
function saveUi() {
  clearTimeout(uiFlush);
  uiFlush = setTimeout(() => writeJsonAtomic(UI_FILE, ui).catch(() => {}), 400);
}

const ATTENTION = new Set(['done', 'failed', 'needs']);

/* A RULE CHANGE IS NOT AN EVENT.

   Everything below hangs on one thing: the lane CHANGED. That is what marks an
   agent unread, stamps the clock "newest activity" sorts on, and buzzes the
   phone. Which means the day the rule itself changes, every agent the new rule
   reads differently looks exactly like an agent that just did something —
   `blocked` without a pid moved from `idle` to `done`, and that is 154 agents
   on this fleet in one tick: 154 unread marks, 154 push notifications, and 154
   rows stamped with today's time at the top of a list sorted by when things
   happened. All of it false; none of it happened now.

   So the version of the rule that wrote `ui.lanes` is written down beside it,
   and the first pass after it changes only CORRECTS the stored lane. No clock,
   no unread, no push, no un-archiving. The agents appear where they belong,
   keeping the timestamps they actually earned, and the next REAL edge is heard
   like any other. Bump this when laneOf starts answering differently. */
const LANE_RULE = 2;


/** Mark unread on the EDGE into a state that wants you, never on the level —
 *  otherwise an agent you already read goes unread again on every poll. */
async function trackLanes(list) {
  const u = await getUi();
  /* One silent pass, and only one: the flag is written at the end of it. The
     body below runs to completion without awaiting anything, so no second
     snapshot can slip in between the reading and the writing of it. */
  const quiet = u.laneRule !== LANE_RULE;
  let dirty = false;
  for (const a of list) {
    const k = a.id || ('sess:' + a.sessionId);
    let l = laneOf(a);
    /* AN AUTO-STOP IS NOT SOMETHING THE AGENT DID. It was done or waiting on
       you before the fleet took its process away to free the RAM, and to you it
       still is: same lane, same "Finished · 2h ago", no unread mark, no push, no
       sinking to the bottom as "Stopped". Only the process is gone — Reply
       brings it back, and the moment it is alive again it is an agent like any
       other. */
    const auto = u.autoStopped[k];
    if (auto) {
      if (a.alive) { delete u.autoStopped[k]; dirty = true; }
      else l = auto.lane;
    }
    a.autoStoppedAt = u.autoStopped[k]?.at || null;
    const prev = u.lanes[k];
    if (prev !== l) {
      u.lanes[k] = l; dirty = true;
      // The edge is the event. Finishing (or asking) is something the agent
      // DID, so the browser sorts on it like on a prompt — and the foot's
      // "Finished · 12s ago" counts from here, not from the daemon's updatedAt.
      if (!quiet) {
        u.laneAt[k] = Date.now();
        if (ATTENTION.has(l) && prev !== undefined) {
          u.unread[k] = { at: Date.now(), lane: l };
          /* The push hangs on the SAME edge as the unread dot and the sound, not
             beside it. One rule, three outputs — otherwise the phone eventually
             rings for something the dashboard does not consider an event. An
             archived agent is one you said you were done with; it may still go
             unread on the server, but it does not get to buzz your pocket. */
          if (!u.archived[k]) notifyLane(a, l, { detailLine: a.activity?.text || '' }).catch(() => {});
        }
        // Coming back to life un-archives: otherwise you reply to an archived
        // agent and it works away where you cannot see it.
        if ((l === 'working' || l === 'needs') && u.archived[k]) delete u.archived[k];
      }
    }
    a.lane = l;                       // the browser must not compute its own
    a.laneAt = u.laneAt[k] || null;
    a.unread = Boolean(u.unread[k]);
    a.archived = Boolean(u.archived[k]);
    a.archivedAt = u.archived[k] || null;
    a.pinned = Boolean(u.pinned[k]);
    a.pinnedAt = u.pinned[k] || null;
  }
  if (quiet) { u.laneRule = LANE_RULE; dirty = true; }
  if (dirty) saveUi();
  return list;
}

// ---------------------------------------------------------------------------
// AUTO-STOP — a finished agent gives its RAM back after an hour.
//
// Measured 2026-09-23: the daemon keeps a background agent's process alive
// after it is done, with no idle timeout. Twelve finished agents sat on 5.1 GB
// of a machine that was already deep into swap — each one ~0.5 GB (the
// `claude` process, its terminal host and every MCP server it started), all of
// it doing nothing.
//
// `claude stop` keeps the conversation; `claude attach` (the Reply button)
// resumes it where it was. And an hour is not an arbitrary number: it is the
// prompt cache's lifetime (`ephemeral_1h_input_tokens`). An agent idle for an
// hour pays a full cache write on its next prompt whether its process lived
// through the hour or not — so stopping it then costs no tokens, only the few
// seconds a resume takes.
//
// ONE derivation (`autoStopPlan`) answers both "whom do I stop" for the tick and
// "when will this one stop" for the panel, so the countdown you read is the
// rule that runs.
// ---------------------------------------------------------------------------
const AUTO_STOP_DEFAULT_MIN = 60;
const AUTO_STOP_LOG = path.join(DATA_DIR, 'auto-stop.log');
let autoStopRecent = null;          // newest first, loaded from the log once

const tsOf = (v) => (typeof v === 'number' ? v : (Date.parse(v || '') || 0));

/** Every living agent, with either the moment it will be stopped or the reason
 *  it will not. The reasons are the whole safety story, in order: never an
 *  interactive session, never while it works, never while its shells or
 *  subagents still run (stopping would kill them), never one you pinned, never
 *  one open in a terminal. The clock is the LATEST sign of life — the
 *  transcript's last write, the lane edge, your last prompt. */
function autoStopPlan(list, u, attached, now = Date.now()) {
  const { min, waiting } = u.autoStop;
  const rows = [];
  for (const a of list) {
    if (!a.alive || !a.pid) continue;
    const key = a.id || ('sess:' + a.sessionId);
    const idleSince = Math.max(tsOf(a.tmtime), tsOf(a.laneAt), tsOf(a.lastPromptAt)) || null;
    let hold = null;
    if (a.kind !== 'background' || !a.id || !SHORT_ID.test(a.id)) hold = 'interactive session';
    else if (a.lane === 'working' || a.status === 'busy') hold = 'working';
    else if (a.shells > 0) hold = `${a.shells} shell${a.shells > 1 ? 's' : ''} running`;
    else if ((a.inflight || 0) - (a.monitors || 0) > 0) hold = 'subagent or task running';
    else if (a.wakeAt && a.wakeAt > now) hold = 'set to wake itself';
    else if (a.lane === 'needs' && !waiting) hold = 'waiting on you';
    else if (a.lane !== 'done' && a.lane !== 'needs') hold = 'not finished';
    else if (u.pinned[key]) hold = 'pinned';
    else if (attached.has(a.id)) hold = 'open in a terminal';
    else if (!idleSince) hold = 'no clock';
    rows.push({
      id: a.id, key, pid: a.pid, name: a.name || a.id || 'session', lane: a.lane, idleSince,
      stopAt: !hold && min > 0 ? idleSince + min * 60000 : null,
      hold,
    });
  }
  return { min, waiting, now, rows };
}

async function autoStopHistory() {
  if (autoStopRecent) return autoStopRecent;
  try {
    const raw = await fsp.readFile(AUTO_STOP_LOG, 'utf8');
    autoStopRecent = raw.trim().split('\n').slice(-200).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  } catch { autoStopRecent = []; }
  return autoStopRecent;
}

let autoStopBusy = false;
/** `force` is the panel's "stop them now" — same plan, same holds, no clock. */
async function autoStopRun({ force = false } = {}) {
  if (autoStopBusy || !CLAUDE_BIN) return { stopped: [] };
  const u = await getUi();
  if (!force && !(u.autoStop.min > 0)) return { stopped: [] };
  autoStopBusy = true;
  const stopped = [];
  try {
    await refreshAgents();                     // a decision to stop rests on a fresh pid and status
    const [list, table] = await Promise.all([snapshot(), processTable(0)]);
    const plan = autoStopPlan(list, u, attachedIds(table));
    const due = plan.rows.filter((r) => !r.hold && (force || (r.stopAt && r.stopAt <= Date.now())));
    const history = await autoStopHistory();
    for (const r of due) {
      /* Checked again one by one against the daemon's latest answer: stopping
         the previous agent took seconds, and a reply from the phone may have
         woken this one in the meantime. */
      const live = agentsCache.list.find((x) => x.id === r.id);
      if (!live?.pid || live.status === 'busy' || live.state === 'working') continue;
      const bytes = lastAgentBytes(r.pid);
      u.autoStopped[r.key] = { at: Date.now(), lane: r.lane, bytes };
      saveUi();
      const res = await runClaude(['stop', r.id], { timeout: 30000 });
      if (!res.ok) { delete u.autoStopped[r.key]; saveUi(); }
      const entry = {
        at: Date.now(), id: r.id, name: r.name, lane: r.lane, force,
        idleMin: Math.round((Date.now() - r.idleSince) / 60000), bytes, ok: res.ok,
        ...(res.ok ? {} : { error: res.stderr.slice(0, 300) }),
      };
      history.unshift(entry);
      if (history.length > 200) history.length = 200;
      await ensureDataDir();
      fsp.appendFile(AUTO_STOP_LOG, JSON.stringify(entry) + '\n').catch(() => {});
      stopped.push(entry);
    }
    if (due.length) agentsCache.at = 0;
  } catch {} finally { autoStopBusy = false; }
  return { stopped };
}

let draftsCache = null, draftsLoading = null;
async function getDrafts() {
  if (draftsCache) return draftsCache;
  // the promise is cached for the same reason as getUi's: two early requests
  // must not each install their own object
  draftsLoading ||= readJsonKeep(DRAFTS_FILE, {}).then((d) => (draftsCache = d || {}));
  return draftsLoading;
}
let draftFlush = null;
/* Deleting a draft leaves a TOMBSTONE, it does not remove the key.
   The client keeps a localStorage mirror and merges "newer wins" on load — and
   a deleted key is simply absent from the server file, so it can never be
   newer than anything. A stale local copy therefore resurrected itself on
   every reload, forever, and clearing a draft in one browser never reached
   another. An empty entry with a timestamp is a fact that can win.
   Tombstones older than TOMBSTONE_TTL are dropped; by then nothing is left to
   out-vote. */
const TOMBSTONE_TTL = 30 * 24 * 3600e3;
async function setDraft(key, text) {
  const d = await getDrafts();
  const now = Date.now();
  d[key] = { text: text || '', at: now };
  for (const [k, v] of Object.entries(d)) {
    if (!v?.text && now - (v?.at || 0) > TOMBSTONE_TTL) delete d[k];
  }
  clearTimeout(draftFlush);
  draftFlush = setTimeout(() => writeJsonAtomic(DRAFTS_FILE, d).catch(() => {}), 400);
  return d;
}

// ---------------------------------------------------------------------------
// Usage. There is no `claude usage` command and no local quota file, so the
// subscription's real weekly limit is simply not knowable from this machine.
// What IS knowable is exact: every assistant message in every transcript
// carries its own token usage. Measured: a full scan of 1.4 GB / 1380 files
// takes 2.5s, and after that only appended bytes are read.
// ---------------------------------------------------------------------------
let usageIdx = null;      // { files: {path: {offset, days}}, builtAt }
let usageBusy = false;

function addDay(days, d, u) {
  const t = (days[d] ||= { out: 0, in: 0, cacheRead: 0, cacheWrite: 0, msgs: 0 });
  t.out += u.output_tokens || 0;
  t.in += u.input_tokens || 0;
  t.cacheRead += u.cache_read_input_tokens || 0;
  t.cacheWrite += u.cache_creation_input_tokens || 0;
  t.msgs += 1;
}

function scanUsageText(text, days) {
  for (const line of text.split('\n')) {
    if (!line.includes('"output_tokens"')) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    const u = d.message?.usage; if (!u) continue;
    const day = (d.timestamp || '').slice(0, 10);
    if (day) addDay(days, day, u);
  }
}

async function refreshUsage() {
  if (usageBusy) return usageIdx;
  usageBusy = true;
  try {
    if (!usageIdx) usageIdx = await readJson(USAGE_FILE, null) || { files: {}, days: {} };
    let dirs = [];
    try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { return usageIdx; }
    let changed = false;
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      let files = [];
      try { files = await fsp.readdir(path.join(PROJECTS_DIR, dir.name)); } catch { continue; }
      for (const name of files) {
        if (!name.endsWith('.jsonl')) continue;
        const p = path.join(PROJECTS_DIR, dir.name, name);
        let st; try { st = await fsp.stat(p); } catch { continue; }
        const rec = usageIdx.files[p];
        // A file that shrank was replaced; anything else only ever grows.
        if (rec && st.size >= rec.offset) {
          if (st.size === rec.offset) continue;
          const { text, offset } = await readFrom(p, rec.offset);
          if (text) { scanUsageText(text, usageIdx.days); rec.offset = offset; changed = true; }
        } else {
          const { text, offset } = await readFrom(p, 0);
          usageIdx.files[p] = { offset };
          if (text) { scanUsageText(text, usageIdx.days); changed = true; }
        }
      }
    }
    if (changed) { usageIdx.builtAt = Date.now(); writeJsonAtomic(USAGE_FILE, usageIdx).catch(() => {}); }
    return usageIdx;
  } finally { usageBusy = false; }
}

/**
 * Anthropic's real limits are not readable from this machine — there is no
 * `claude usage` command and no quota file, both checked. So instead of faking
 * a percentage of a limit nobody can see, this compares you against YOURSELF:
 * how far into the week you are versus how much of a typical week you have
 * already spent. That is a question the data can actually answer.
 */
function usageReport(idx) {
  const days = idx?.days || {};
  const key = (d) => d.toISOString().slice(0, 10);
  const now = new Date();
  const today = key(now);
  const out = (k) => days[k]?.out || 0;

  const list = [];
  for (let i = 27; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(d.getUTCDate() - i);
    const k = key(d);
    list.push({ day: k, ...(days[k] || { out: 0, in: 0, cacheRead: 0, cacheWrite: 0, msgs: 0 }) });
  }

  // week = Monday 00:00 UTC to now
  const dow = (now.getUTCDay() + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dow));
  let weekToDate = 0;
  for (const d = new Date(weekStart); d <= now; d.setUTCDate(d.getUTCDate() + 1)) weekToDate += out(key(d));
  const weekElapsed = Math.max(0, Math.min(1, (now - weekStart) / (7 * 86400000)));

  // a "typical day" from the past 28 days, ignoring days you did not work and
  // ignoring today (which is still running)
  const past = list.slice(0, -1).filter((d) => d.out > 0);
  const avgDay = past.length ? Math.round(past.reduce((s, d) => s + d.out, 0) / past.length) : 0;
  const typicalWeek = avgDay * 7;

  return {
    today: out(today),
    todayVsTypical: avgDay ? out(today) / avgDay : 0,
    weekToDate,
    typicalWeek,
    weekUsedFrac: typicalWeek ? weekToDate / typicalWeek : 0,
    weekElapsedFrac: weekElapsed,
    avgDay,
    activeDays: past.length,
    weekStart: weekStart.toISOString(),
    days: list.slice(-14),
    builtAt: idx?.builtAt || null,
  };
}

// ---------------------------------------------------------------------------
// CONTEXT BUDGET
//
// The question this answers: *how much of the window is gone before an agent
// has read a single line of code, and is it still growing?*
//
// Two costs, and they are NOT the same thing:
//
//   BASELINE  — what CLAUDE.md pulls into EVERY session of a project via its
//               `@`-imports, plus the global CLAUDE.md and that project's
//               memory index. Fully knowable from disk. This is the number that
//               creeps: a doc grows by a paragraph a day and nobody sees it,
//               because the cost is paid by every agent, silently, forever.
//               Measured 2026-07-31 in one repo: an imported notes file had
//               reached 446 KB ≈ 111k tokens and had doubled in three days.
//
//   LIVE      — what a running session is ACTUALLY carrying right now, read
//               from the last assistant message's usage. This is not an
//               estimate; it is the number the API was billed for.
//
// WHY THE WINDOW SIZE IS OBSERVED, NOT ASSUMED: the same reason usageReport()
// gives for not faking a quota — the real limit is not readable from this
// machine. So it is derived from the user's own transcripts: the largest
// context each model has ever carried here, rounded up to the nearest tier.
// Measured 2026-08-03: opus-5 / opus-4-8 / fable-5 reached
// ~999.9k, sonnet-4-6 topped out at ~166k before compacting. A model nobody has
// pushed yet falls back to the conservative tier rather than inventing a limit.
// ---------------------------------------------------------------------------

const CTX_TIERS = [200_000, 1_000_000];
const CTX_FALLBACK = 200_000;

/** Round an observed high-water mark up to the nearest real window tier. */
function ctxTierFor(observed) {
  for (const t of CTX_TIERS) if (observed <= t * 1.02) return t;
  return CTX_TIERS[CTX_TIERS.length - 1];
}

/**
 * Resolve every CLAUDE.md that a session in `cwd` actually loads.
 *
 * THE PART THAT IS EASY TO GET WRONG — and this function did, until 2026-08-03:
 * it is NOT just `<cwd>/CLAUDE.md`. Claude Code walks UP the directory tree from
 * the working directory and loads every CLAUDE.md and CLAUDE.local.md it finds
 * on the way. Running in `repo/packages/app` therefore still loads `repo/CLAUDE.md`
 * with all of its imports. Measuring only the leaf reported a subdirectory as
 * 584 tokens when it really carries 29k — the panel said "cheap" about the most
 * expensive thing on the machine.
 *
 * The other trap is the `@`-import: it costs every session forever and reads
 * like a link in review. Imports are followed the way Claude Code follows them —
 * recursively, relative to the file that names them, max four hops.
 */
async function readBaselineFiles(cwd) {
  const files = [];
  const seen = new Set();

  async function add(file, why, depth = 0) {
    const abs = path.resolve(file);
    if (seen.has(abs) || depth > 4) return;
    seen.add(abs);
    let text;
    try { text = await fsp.readFile(abs, 'utf8'); } catch { return; }
    // Block-level HTML comments are stripped before injection, so they cost
    // nothing — counting them would overstate the bill.
    const injected = text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, '');
    files.push({ path: abs, why, bytes: Buffer.byteLength(injected, 'utf8') });
    for (const line of injected.split('\n')) {
      const m = /^@(\S+)/.exec(line.trim());
      if (!m) continue;
      let p = m[1];
      if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
      await add(path.isAbsolute(p) ? p : path.join(path.dirname(abs), p), 'imported by ' + path.basename(abs), depth + 1);
    }
  }

  // User scope first, then the directory chain from the filesystem root down to
  // cwd — the same order Claude Code concatenates them in.
  await add(path.join(CLAUDE_DIR, 'CLAUDE.md'), 'global, every project');
  for (const f of await unconditionalRules(path.join(CLAUDE_DIR, 'rules'))) await add(f, 'global rule');

  if (cwd) {
    const chain = [];
    for (let p = path.resolve(cwd); p && p !== path.dirname(p); p = path.dirname(p)) chain.unshift(p);
    for (const dir of chain) {
      const leaf = dir === path.resolve(cwd);
      const why = leaf ? 'project root' : `inherited from ${path.basename(dir)}/`;
      await add(path.join(dir, 'CLAUDE.md'), why);
      await add(path.join(dir, '.claude', 'CLAUDE.md'), why);
      await add(path.join(dir, 'CLAUDE.local.md'), why + ', local');
      for (const f of await unconditionalRules(path.join(dir, '.claude', 'rules'))) await add(f, 'rule');
    }
  }
  return files;
}

/**
 * `.claude/rules/*.md` load at launch — EXCEPT those with a `paths:` frontmatter,
 * which only load when Claude touches a matching file. That distinction is the
 * cheapest lever there is for a big always-loaded file, so the panel must not
 * bill a path-scoped rule as if it were permanent.
 */
async function unconditionalRules(dir) {
  let names = [];
  try { names = await fsp.readdir(dir, { recursive: true }); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!String(n).endsWith('.md')) continue;
    const p = path.join(dir, String(n));
    try {
      const head = (await fsp.readFile(p, 'utf8')).slice(0, 400);
      if (/^---[\s\S]*?\bpaths:/.test(head)) continue; // conditional → not always loaded
      out.push(p);
    } catch {}
  }
  return out;
}

/**
 * Daily baseline history — the whole point of the panel.
 *
 * A single measurement cannot tell you the thing that actually hurts. "29k
 * tokens" reads as fine; "29k, and it was 18k on Monday" is the alarm. The
 * failure mode being watched for is not a big number, it is a number that grows
 * a paragraph a day because every agent that finishes a task wants to write
 * down what it learned, and the always-loaded file is the first place it looks.
 *
 * One entry per project per day: this file must stay small enough that nobody
 * ever has to prune it.
 */
const CTX_HISTORY_FILE = path.join(DATA_DIR, 'context-history.json');
let ctxHistory = null;

async function recordBaseline(cwd, tok) {
  if (!ctxHistory) ctxHistory = await readJson(CTX_HISTORY_FILE, null) || {};
  const day = new Date().toISOString().slice(0, 10);
  const byDay = (ctxHistory[cwd] ||= {});
  if (byDay[day] === tok) return;
  byDay[day] = tok;
  // Keep it bounded without a pruning job: 120 days is plenty of trend.
  const days = Object.keys(byDay).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 120))) delete byDay[d];
  writeJsonAtomic(CTX_HISTORY_FILE, ctxHistory).catch(() => {});
}

/** Baseline N days ago (the closest earlier sample), or null if never seen. */
function baselineBack(cwd, days) {
  const byDay = ctxHistory?.[cwd];
  if (!byDay) return null;
  const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const earlier = Object.keys(byDay).filter((d) => d <= cut).sort();
  return earlier.length ? byDay[earlier[earlier.length - 1]] : null;
}

/**
 * The traffic light for the baseline is deliberately NOT "percent of window".
 *
 * With a 1M window a 29k baseline is 3% and every project would glow green
 * forever — while still costing 29k tokens on every single session of every
 * single agent, which is the actual bill. So the light reads the two things
 * that a human would call "bloated": how big it is in absolute terms, and
 * whether it is still climbing.
 */
function baselineLight(tok, weekAgo) {
  const grow = weekAgo ? (tok - weekAgo) / weekAgo : 0;
  if (tok > 50_000 || grow > 0.25) return 'red';
  if (tok > 25_000 || grow > 0.10) return 'amber';
  return 'green';
}

let ctxCache = null;
let ctxAt = 0;

async function contextReport() {
  if (ctxCache && Date.now() - ctxAt < 4000) return ctxCache;

  // 1. Walk each project's newest transcripts for cwd, model and live context.
  const projects = new Map(); // cwd -> { sessions: [] }
  const modelMax = new Map();
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS_DIR, { withFileTypes: true }); } catch { dirs = []; }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dpath = path.join(PROJECTS_DIR, dir.name);
    let names = [];
    try { names = await fsp.readdir(dpath); } catch { continue; }

    const stats = [];
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      try { stats.push({ p: path.join(dpath, n), m: (await fsp.stat(path.join(dpath, n))).mtimeMs }); } catch {}
    }
    stats.sort((a, b) => b.m - a.m);

    // Only the recently touched ones — an archive of 200 old sessions is not a
    // budget question, and reading all of them would make this route expensive.
    for (const s of stats.slice(0, 6)) {
      if (Date.now() - s.m > 14 * 86400000) continue;
      let text = '';
      try { text = await readTail(s.p, 512 * 1024); } catch { continue; }
      if (typeof text !== 'string') text = text?.text || '';

      let cwd = null, model = null, ctx = 0, at = null;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let d; try { d = JSON.parse(line); } catch { continue; }
        if (d.cwd) cwd = d.cwd;
        const u = d.message?.usage;
        if (!u) continue;
        const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (!t) continue;
        ctx = t;
        model = d.message?.model || model;
        at = d.timestamp || at;
        if (model) modelMax.set(model, Math.max(modelMax.get(model) || 0, t));
      }
      if (!cwd || !ctx) continue;
      const rec = projects.get(cwd) || { cwd, sessions: [] };
      rec.sessions.push({
        id: path.basename(s.p, '.jsonl'), model, ctx, at,
        mtime: s.m, live: Date.now() - s.m < 120000,
      });
      projects.set(cwd, rec);
    }
  }

  // 2. Window per model, observed rather than assumed.
  const windows = {};
  for (const [m, obs] of modelMax) windows[m] = ctxTierFor(obs);

  // 3. Baseline per project.
  const out = [];
  for (const rec of projects.values()) {
    const files = await readBaselineFiles(rec.cwd);
    // Auto memory hangs off the GIT REPO, not the cwd: all subdirectories and
    // worktrees of one repo share a single memory directory. And only the first
    // 200 lines / 25 KB of MEMORY.md are loaded — billing the whole file would
    // overstate a long index and hide the fact that the rest never arrives.
    const memIdx = await findMemoryIndex(rec.cwd);
    if (memIdx) {
      try {
        const raw = await fsp.readFile(memIdx, 'utf8');
        const loaded = raw.split('\n').slice(0, 200).join('\n').slice(0, 25_600);
        files.push({
          path: memIdx,
          why: raw.length > loaded.length ? 'memory index (truncated at the 200-line / 25 KB limit)' : 'memory index',
          bytes: Buffer.byteLength(loaded, 'utf8'),
        });
      } catch {}
    }

    const baselineBytes = files.reduce((s, f) => s + f.bytes, 0);
    const baselineTok = Math.round(baselineBytes / 4);
    rec.sessions.sort((a, b) => b.mtime - a.mtime);
    const win = windows[rec.sessions[0]?.model] || CTX_FALLBACK;

    await recordBaseline(rec.cwd, baselineTok);
    const weekAgo = baselineBack(rec.cwd, 7);
    const monthAgo = baselineBack(rec.cwd, 30);

    out.push({
      cwd: rec.cwd,
      name: path.basename(rec.cwd),
      baselineBytes,
      baselineTok,
      baselineFrac: baselineTok / win,
      light: baselineLight(baselineTok, weekAgo),
      weekAgo,
      monthAgo,
      growWeek: weekAgo ? (baselineTok - weekAgo) / weekAgo : null,
      history: Object.entries(ctxHistory?.[rec.cwd] || {}).sort().slice(-30),
      window: win,
      files: files.sort((a, b) => b.bytes - a.bytes),
      sessions: rec.sessions.map((s) => ({
        ...s,
        window: windows[s.model] || CTX_FALLBACK,
        frac: s.ctx / (windows[s.model] || CTX_FALLBACK),
      })),
      liveCount: rec.sessions.filter((s) => s.live).length,
    });
  }

  out.sort((a, b) => (b.liveCount - a.liveCount) || (b.baselineTok - a.baselineTok));

  // What concurrency actually costs. Every agent on a repo pays that repo's
  // baseline in full — the files are re-sent per session, they are not shared
  // between them. Eight agents on a 29k baseline is 232k tokens of identical
  // boilerplate in flight, and that is the honest token line for "many agents
  // at once", separate from the dev servers below (which cost CPU, not tokens).
  const liveAgents = out.reduce((s, p) => s + p.liveCount, 0);
  const boilerplate = out.reduce((s, p) => s + p.liveCount * p.baselineTok, 0);
  const worst = out.reduce((a, b) => (a && a.baselineTok >= b.baselineTok ? a : b), null);

  ctxCache = {
    projects: out,
    windows,
    servers: await devServers(),
    summary: {
      liveAgents,
      boilerplate,
      worstLight: out.some((p) => p.light === 'red') ? 'red'
        : out.some((p) => p.light === 'amber') ? 'amber' : 'green',
      worstProject: worst ? worst.name : null,
      worstTok: worst ? worst.baselineTok : 0,
    },
    builtAt: Date.now(),
  };
  ctxAt = Date.now();
  return ctxCache;
}

/** Claude Code's own encoding: every non-alphanumeric run becomes a dash. */
function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * The memory index for a working directory.
 *
 * Keyed by the git repository, so `repo/packages/app` and `repo` share one. Falls
 * back to the cwd's own directory for work outside a repo — which is exactly
 * what Claude Code does.
 */
async function findMemoryIndex(cwd) {
  const dirs = [];
  for (let p = path.resolve(cwd); p && p !== path.dirname(p); p = path.dirname(p)) {
    dirs.push(p);
    try { await fsp.stat(path.join(p, '.git')); break; } catch {}
  }
  // Nearest match wins: the repo root if we found one, else the cwd itself.
  for (const d of [dirs[dirs.length - 1], dirs[0]]) {
    if (!d) continue;
    const f = path.join(PROJECTS_DIR, encodeProjectDir(d), 'memory', 'MEMORY.md');
    try { await fsp.stat(f); return f; } catch {}
  }
  return null;
}

/**
 * Dev servers currently listening.
 *
 * WHY THIS SITS IN A CONTEXT PANEL: many agents on one repo is the case where
 * waste multiplies, and the visible symptom is a pile of half-dead dev servers
 * — measured in one repo: five running, four orphaned. Those cost CPU and RAM
 * rather than tokens directly; the honest token line is the one above it
 * (agents × baseline). Both belong to the same question: what is this repo
 * paying for the fact that eight agents work on it at once?
 */
async function devServers() {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 4000 }, (err, stdout) => {
      if (err && !stdout) return resolve([]);
      const byPort = new Map();
      for (const line of String(stdout || '').split('\n').slice(1)) {
        const f = line.trim().split(/\s+/);
        if (f.length < 9) continue;
        const cmd = f[0], pid = Number(f[1]);
        const addr = f[8] || '';
        const m = /:(\d+)$/.exec(addr);
        if (!m) continue;
        const port = Number(m[1]);
        if (!/^(node|Python|python3?|deno|bun|ruby|java)/i.test(cmd)) continue;
        if (port < 1024) continue;
        const cur = byPort.get(port);
        if (!cur) byPort.set(port, { port, cmd, pids: [pid] });
        else if (!cur.pids.includes(pid)) cur.pids.push(pid);
      }
      resolve([...byPort.values()].sort((a, b) => a.port - b.port));
    });
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

/** Raw bytes, for uploads. Resolves null if the limit is exceeded. */
function readRaw(req, limit) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { resolve(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const SHORT_ID = /^[0-9a-f]{6,16}$/i;
const ACTIONS = { stop: 'stop', respawn: 'respawn', rm: 'rm' };

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const sseClients = new Set();
/** One event to the windows of one workspace (or whichever `match` picks). */
function sseTo(match, event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) if (match(c)) { try { c.res.write(line); } catch {} }
}
function liveByWs() {
  const m = {};
  for (const c of sseClients) m[c.ws || 'main'] = (m[c.ws || 'main'] || 0) + 1;
  return m;
}

/* ONLY THIS PAGE MAY DRIVE THE SERVER. Binding 127.0.0.1 keeps other machines
   out, not other websites: any page open in the same browser can reach
   127.0.0.1 as well. A form post or a no-cors fetch needs no preflight, and a
   WebSocket is not covered by CORS at all, so without a check a page you merely
   visit could start an agent or type into one of its terminals. Two headers
   close that. Host must name this machine, which defeats DNS rebinding (a
   hostile domain re-pointed at 127.0.0.1 still sends its own name). Origin,
   which a browser attaches to every cross-origin request and every WebSocket
   handshake, must be this page or absent; absent means curl or another local
   program, which could run `claude` directly anyway. */
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
function fromThisPage(req) {
  const host = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(String(req.headers.host || ''));
  if (!host || !LOCAL_NAMES.has(host[1].toLowerCase()) || Number(host[2] || 80) !== PORT) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    const o = new URL(origin);
    return o.protocol === 'http:' && LOCAL_NAMES.has(o.hostname.toLowerCase()) && Number(o.port || 80) === PORT;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  if (!fromThisPage(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden: flotilla only answers its own page\n');
  }
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = u.pathname;

  try {
    // The sequence number goes with it: this is also how a browser that lost
    // track of the delta feed gets back in step.
    if (p === '/api/agents') return sendJSON(res, 200, { seq: feedSeq, agents: await snapshot() });

    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`event: ping\ndata: ${Date.now()}\n\n`);
      // `seq: null`, never a number: a fresh connection has no base to apply a
      // difference to, so its first message is always the whole list.
      // `ws` is which workspace the window shows — it is how the workspace list
      // knows which ones have a window open right now (a tab from before
      // workspaces existed sends none and is the main one)
      const client = { res, seq: null, ws: String(u.searchParams.get('ws') || 'main').slice(0, 64) };
      sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return;
    }

    if (p === '/api/transcript') {
      const sid = u.searchParams.get('session') || '';
      const file = await findTranscript(sid);
      // 200, not 404: a just-started agent has no transcript for a second or
      // two, and a red console error for a normal state is noise, not news.
      if (!file) return sendJSON(res, 200, { error: 'No transcript yet', sessionId: sid, events: [], offset: 0 });

      // `from` turns this into a delta read: only what was appended since.
      // That is what makes a live conversation cheap instead of a re-render.
      const fromRaw = u.searchParams.get('from');
      if (fromRaw != null) {
        const from = Math.max(0, Number(fromRaw) || 0);
        const { text, offset, size } = await readFrom(file, from);
        return sendJSON(res, 200, { sessionId: sid, delta: true, offset, size, events: parseTranscript(text) });
      }

      const max = Math.min(Number(u.searchParams.get('max') || 1_500_000), 40_000_000);
      const { text, truncated, size } = await readTail(file, max);
      const events = parseTranscript(text);
      return sendJSON(res, 200, { sessionId: sid, file, size, truncated, shown: max, offset: size, events });
    }

    if (p === '/api/timeline') {
      const id = u.searchParams.get('id') || '';
      if (!SHORT_ID.test(id)) return sendJSON(res, 400, { error: 'bad id' });
      try {
        const raw = await fsp.readFile(path.join(JOBS_DIR, id, 'timeline.jsonl'), 'utf8');
        const rows = raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        return sendJSON(res, 200, { rows });
      } catch { return sendJSON(res, 200, { rows: [] }); }
    }

    if (p === '/api/action' && req.method === 'POST') {
      const b = await readBody(req);
      const sub = ACTIONS[b.action];
      if (!sub) return sendJSON(res, 400, { error: 'unknown action' });
      if (!SHORT_ID.test(b.id || '')) return sendJSON(res, 400, { error: 'invalid id' });
      if (sub === 'respawn' && (await snapshot()).find((a) => a.id === b.id)?.runtime === 'bedrock') {
        const why = await bedrockBlocked();
        if (why) return sendJSON(res, 403, { error: why });
      }
      const r = await runClaude([sub, b.id]);
      agentsCache.at = 0;
      return sendJSON(res, 200, r);
    }

    if (p === '/api/dispatch' && req.method === 'POST') {
      const b = await readBody(req);
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return sendJSON(res, 400, { error: 'empty prompt' });
      const cwd = String(b.cwd || '').trim();
      if (!cwd) return sendJSON(res, 400, { error: 'no directory' });
      try {
        const st = await fsp.stat(cwd);
        if (!st.isDirectory()) throw new Error('not a dir');
      } catch { return sendJSON(res, 400, { error: 'Directory does not exist: ' + cwd }); }

      const runtime = RUNTIMES[String(b.runtime || '')] ? String(b.runtime) : DEFAULT_RUNTIME;
      const model = String(b.model || '');
      if (runtime === 'bedrock') {
        const why = await bedrockBlocked();
        if (why) return sendJSON(res, 403, { error: why });
      }

      /* Written before the spawn so a missing key fails HERE, with a sentence,
         instead of becoming an agent that dies on its first request. */
      let settingsFile = null;
      if (runtime !== DEFAULT_RUNTIME) {
        try {
          settingsFile = await settingsFileFor(runtime, { model, effort: String(b.effort || DEFAULT_EFFORT) });
        } catch (e) {
          return sendJSON(res, 400, { error: String(e?.message || e) });
        }
      }

      // argv array — a prompt can never become a command.
      const args = ['--bg'];
      if (b.name) args.push('--name', String(b.name));
      /* On an overridden runtime the model rides in ANTHROPIC_MODEL instead, so
         that the choice has one owner. Passing --model too would let the flag
         and the env block disagree about what is running. */
      if (model && runtime === DEFAULT_RUNTIME) args.push('--model', model);
      /* Always explicit: left out, a session inherits whatever effort Claude
         Code last saved as the user default — a `/effort max` typed weeks ago
         in some other pane would silently decide what every new agent costs. */
      args.push('--effort', String(b.effort || DEFAULT_EFFORT));
      if (b.agent) args.push('--agent', String(b.agent));
      if (b.permissionMode) args.push('--permission-mode', String(b.permissionMode));
      /* A non-native runtime WITHOUT a settings file would be a Claude run
         under a false name: the command would look normal, the agent would
         run on the Anthropic API, and the only trace would be a model name in
         the transcript that nobody checks. Better not to start at all. */
      if (runtime !== DEFAULT_RUNTIME && !settingsFile) {
        return sendJSON(res, 500, { error: `${runtime}: no settings file written — not started` });
      }
      if (settingsFile) args.push('--settings', settingsFile);
      args.push(prompt);

      const r = await runClaude(args, { cwd, timeout: 60000 });
      if (r.ok) await noteRuntime(agentIdFromDispatch(r.stdout), runtime);
      agentsCache.at = 0;
      return sendJSON(res, 200, { ...r, runtime });
    }

    if (p === '/api/open-terminal' && req.method === 'POST') {
      const b = await readBody(req);
      if (!SHORT_ID.test(b.id || '')) return sendJSON(res, 400, { error: 'invalid id' });
      const backTo = String(b.backTo || 'Google Chrome').replace(/["\\]/g, '');
      // A wrapper that: attaches, and on detach brings your browser back and
      // closes its own window. `open -a` needs no automation permission.
      const script = `${JSON.stringify(CLAUDE_BIN)} attach ${b.id}; open -a ${JSON.stringify(backTo)} >/dev/null 2>&1; osascript -e 'tell application "Terminal" to close (every window whose name contains "flotilla")' >/dev/null 2>&1 &`;
      const osa = [
        '-e', 'tell application "Terminal"',
        '-e', 'activate',
        '-e', `do script ${JSON.stringify(script)}`,
        '-e', 'set custom title of front window to "flotilla"',
        '-e', 'end tell',
      ];
      const r = await new Promise((resolve) => {
        execFile('/usr/bin/osascript', osa, { timeout: 15000 }, (err, so, se) => {
          resolve({ ok: !err, stdout: String(so || ''), stderr: String(se || err?.message || ''), cmd: `claude attach ${b.id}  (Terminal.app)` });
        });
      });
      return sendJSON(res, 200, r);
    }

    if (p === '/api/read' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await getUi();
      if (!b.key) return sendJSON(res, 400, { error: 'bad key' });
      if (b.unread) u.unread[b.key] = { at: Date.now(), lane: u.lanes[b.key] || null };
      else delete u.unread[b.key];
      saveUi();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/restart-probe' && req.method === 'GET') return sendJSON(res, 200, { pid: process.pid });

    if (p === '/api/restart' && req.method === 'POST') {
      sendJSON(res, 200, { ok: true, pid: process.pid });
      restartSelf();
      return;
    }

    /* With workspaces, "everything" is everything IN THIS WINDOW: the browser
       sends the keys it shows. Clearing all of them from a second workspace
       would wipe the unread marks of a folder you are not even looking at.
       No `keys` = the old meaning, for a tab still running the old page. */
    if (p === '/api/read-all' && req.method === 'POST') {
      const b = await readBody(req, 4 * 1024 * 1024).catch(() => ({}));
      const u = await getUi();
      if (Array.isArray(b.keys)) for (const k of b.keys) delete u.unread[k];
      else u.unread = {};
      saveUi();
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/archive' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await getUi();
      if (!b.key) return sendJSON(res, 400, { error: 'bad key' });
      const out = { ok: true, cmd: null };
      if (b.archived) {
        u.archived[b.key] = Date.now();
        delete u.unread[b.key];
        // A pin means "keep it in sight"; the archive is the opposite room. The
        // two cannot both be true, and a pin on a row that cannot be drawn is a
        // ghost you can never take off again.
        delete u.pinned[b.key];
        // Archiving is a dashboard-side hide. Stopping is what actually frees
        // the ~460 MB, so it is offered here — but it is a real mutation and is
        // therefore always reported back as the command it ran.
        if (b.stop && SHORT_ID.test(b.key)) {
          const r = await runClaude(['stop', b.key]);
          agentsCache.at = 0;
          Object.assign(out, r);
        }
      } else delete u.archived[b.key];
      saveUi();
      return sendJSON(res, 200, out);
    }

    /* PINNED sits beside ARCHIVED, and for the same reason: it is a mark YOU
       put on an agent, so it has to survive a reload and be there in the second
       window too. The value is WHEN it was pinned — the newest pin goes on top,
       so pinning a second chat never pushes the first one out of view. */
    if (p === '/api/pin' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await getUi();
      if (!b.key) return sendJSON(res, 400, { error: 'bad key' });
      if (b.pinned) u.pinned[b.key] = Date.now(); else delete u.pinned[b.key];
      saveUi();
      return sendJSON(res, 200, { ok: true, pinned: Boolean(b.pinned) });
    }

    /* PUSH. The config lives on the server for the same reason `pinned` does:
       it is not a property of a browser. The notification has to go out while
       every window is closed — that is the entire point of it. */
    if (p === '/api/push' && req.method === 'GET') return sendJSON(res, 200, await pushState());

    if (p === '/api/push' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.suggest) return sendJSON(res, 200, { topic: suggestTopic() });
      if (b.test) {
        try {
          await notifyPlain('flotilla', 'Test — the connection works.');
          return sendJSON(res, 200, { ok: true });
        } catch (e) { return sendJSON(res, 200, { ok: false, error: String(e.message || e) }); }
      }
      return sendJSON(res, 200, await setPush(b));
    }

    if (p === '/api/prefs' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await getUi();
      u.prefs = { ...u.prefs, ...(b.prefs || {}) };
      saveUi();
      return sendJSON(res, 200, { prefs: u.prefs });
    }

    // The whole visual arrangement lives here, so a reload, a server restart and
    // a reboot all come back to the same desk.
    // A layout is only ever REPLACED, never deleted: a post without one is a
    // bug in a page, and a bug must not be able to take a desk with it.
    // The other windows of the same workspace get it at once, so two tabs of
    // one desk stop overwriting each other with what they remembered.
    if (p === '/api/workspace' && req.method === 'POST') {
      const b = await readBody(req, 8 * 1024 * 1024);
      const u = await getUi();
      const name = String(b.name || 'main').slice(0, 64);
      if (!b.layout || !Array.isArray(b.layout.cols)) return sendJSON(res, 400, { error: 'no layout' });
      u.workspaces[name] = b.layout;
      ensureWs(u, name).usedAt = Date.now();
      saveUi();
      sseTo((c) => c.ws === name, 'layout', { name, layout: b.layout, from: b.from || null });
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/workspaces' && req.method === 'GET') {
      const u = await getUi();
      const agents = await snapshot();
      const live = liveByWs();
      const list = Object.entries(u.wsInfo).map(([name, i]) => {
        const mine = agents.filter((a) => !a.archived && underRoot(a.cwd, i.root));
        return {
          name, title: i.title || '', root: i.root, hidden: Boolean(i.hidden),
          createdAt: i.createdAt || 0, usedAt: i.usedAt || 0,
          panes: (u.workspaces[name]?.cols || []).reduce((s, c) => s + (c.panes?.length || 0), 0),
          agents: mine.length, unread: mine.filter((a) => a.unread).length,
          live: live[name] || 0,
        };
      });
      // the folders agents actually work in, a nested one counted with the one around it
      const roots = new Map();
      for (const a of agents) if (a.cwd && !a.archived) { const r = repoRootOf(a.cwd); roots.set(r, (roots.get(r) || 0) + 1); }
      const kept = new Map();
      for (const r of [...roots.keys()].sort((x, y) => x.length - y.length)) {
        const outer = [...kept.keys()].find((k) => underRoot(r, k));
        if (outer) kept.set(outer, kept.get(outer) + roots.get(r)); else kept.set(r, roots.get(r));
      }
      const folders = [...kept].map(([root, n]) => ({ root, agents: n, covered: list.some((w) => w.root === root) }))
        .sort((x, y) => y.agents - x.agents);
      return sendJSON(res, 200, { workspaces: list, folders, home: HOME });
    }

    if (p === '/api/workspaces' && req.method === 'POST') {
      const b = await readBody(req);
      const u = await getUi();
      if (b.action === 'create') {
        const r = await checkRoot(b.root);
        if (r.error) return sendJSON(res, 400, r);
        const name = newWsName(u, r.root);
        u.wsInfo[name] = { root: r.root, title: String(b.title || '').trim().slice(0, 80), createdAt: Date.now(), usedAt: Date.now() };
        u.workspaces[name] ||= { cols: [] };
        saveUi();
        return sendJSON(res, 200, { ok: true, name, ws: u.wsInfo[name] });
      }
      if (b.action === 'update') {
        const name = String(b.name || '');
        const info = u.wsInfo[name];
        if (!info) return sendJSON(res, 404, { error: 'Unknown workspace: ' + name });
        if (b.root !== undefined) { const r = await checkRoot(b.root); if (r.error) return sendJSON(res, 400, r); info.root = r.root; }
        if (b.title !== undefined) info.title = String(b.title).trim().slice(0, 80);
        if (b.hidden !== undefined) info.hidden = name === 'main' ? false : Boolean(b.hidden);
        if (b.allFolders !== undefined) info.allFolders = Boolean(b.allFolders);
        saveUi();
        sseTo((c) => c.ws === name, 'wsinfo', { name, ws: info });
        return sendJSON(res, 200, { ok: true, ws: info });
      }
      return sendJSON(res, 400, { error: 'bad action' });
    }

    if (p === '/api/ui-state') {
      const wsName = String(u.searchParams.get('ws') || 'main').slice(0, 64);
      const st = await getUi();
      return sendJSON(res, 200, {
        prefs: st.prefs,
        workspaces: st.workspaces,
        ws: ensureWs(st, wsName),      // the folder of the window that asked
        wsInfo: st.wsInfo,
        archived: Object.keys(st.archived).length,
        unread: Object.keys(st.unread).length,
        pinned: Object.keys(st.pinned).length,
      });
    }

    /* Attachments. A browser is never told the real path of a dropped file, so
       the file has to be written somewhere the agent can read and then referred
       to by path — which is exactly what Claude Code's own Remote Control does
       with attachments from the phone. It lands in OUR data dir, never in your
       repo, and the reference goes into the prompt as plain text. */
    if (p === '/api/attach' && req.method === 'POST') {
      const raw = String(req.headers['x-filename'] || 'file');
      let name = path.basename(decodeURIComponent(raw)).replace(/[/\\]/g, '');
      name = name.replace(/[^\w.\- ()\[\]]+/g, '_').slice(0, 120) || 'file';
      if (name.startsWith('.')) name = '_' + name;

      const buf = await readRaw(req, 32 * 1024 * 1024);
      if (!buf) return sendJSON(res, 413, { error: 'File too large (limit 32 MB)' });

      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(DATA_DIR, 'attachments', day);
      await fsp.mkdir(dir, { recursive: true });

      // never overwrite: two files called notes.pdf are two different files
      let file = path.join(dir, name), n = 1;
      const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
      while (true) {
        try { await fsp.access(file); file = path.join(dir, `${stem}-${n++}${ext}`); }
        catch { break; }
      }
      await fsp.writeFile(file, buf);
      return sendJSON(res, 200, { path: file, name: path.basename(file), size: buf.length });
    }

    if (p === '/api/drafts' && req.method === 'GET') return sendJSON(res, 200, { drafts: await getDrafts() });

    if (p === '/api/drafts' && req.method === 'POST') {
      const b = await readBody(req, 4 * 1024 * 1024); // pages of ideas are expected
      if (typeof b.key !== 'string' || !b.key) return sendJSON(res, 400, { error: 'bad key' });
      const d = await setDraft(b.key, typeof b.text === 'string' ? b.text : '');
      return sendJSON(res, 200, { ok: true, count: Object.keys(d).length });
    }

    if (p === '/api/context') return sendJSON(res, 200, await contextReport());

    if (p === '/api/usage') {
      const idx = await refreshUsage();
      return sendJSON(res, 200, usageReport(idx));
    }

    /* RAM. The strip in the top bar asks without `procs` every few seconds and
       costs ~20 ms. The panel asks WITH it, which starts a `top` in the
       background (~8 s on a loaded machine) and answers with the previous one —
       `procs: null` only until the very first sample is in. */
    if (p === '/api/memory') {
      const sys = await systemMemory();
      if (!u.searchParams.get('procs')) return sendJSON(res, 200, { sys });
      const [list, table] = await Promise.all([snapshot(), processTable()]);
      const st = await getUi();
      const plan = autoStopPlan(list, st, attachedIds(table));
      const procs = processMemory({
        agents: list.filter((a) => a.pid).map((a) => ({ pid: a.pid, id: a.id, name: a.name })),
        selfPid: process.pid,
      });
      const history = await autoStopHistory();
      const today = new Date().toDateString();
      const todays = history.filter((h) => h.ok && new Date(h.at).toDateString() === today);
      return sendJSON(res, 200, {
        sys,
        procs,
        autoStop: {
          ...plan,
          rows: plan.rows.map((r) => ({ ...r, bytes: procs?.agentBytes[r.pid] ?? null })),
          today: { count: todays.length, bytes: todays.reduce((s, h) => s + (h.bytes || 0), 0) },
          recent: history.slice(0, 8),
        },
      });
    }

    if (p === '/api/autostop' && req.method === 'POST') {
      const b = await readBody(req);
      const st = await getUi();
      if (b.min !== undefined) {
        const min = Number(b.min);
        if (!Number.isFinite(min) || min < 0 || min > 24 * 60) return sendJSON(res, 400, { error: 'bad min' });
        st.autoStop.min = min;
      }
      if (b.waiting !== undefined) st.autoStop.waiting = Boolean(b.waiting);
      saveUi();
      const out = { ok: true, autoStop: st.autoStop };
      if (b.now) Object.assign(out, await autoStopRun({ force: true }));
      return sendJSON(res, 200, out);
    }

    if (p === '/api/bedrock-budget') {
      return sendJSON(res, 200, await refreshBedrockBudget());
    }

    if (p === '/api/meta') {
      return sendJSON(res, 200, {
        claudeBin: CLAUDE_BIN,
        home: HOME,
        jobsDir: JOBS_DIR,
        projectsDir: PROJECTS_DIR,
        cwds: [...new Set((await snapshot()).map((a) => a.cwd).filter(Boolean))],
        runtimes: runtimeCatalogue(await runtimeKeys(), { bedrock: await refreshBedrockBudget().catch(() => budgetView) }),
        defaultRuntime: DEFAULT_RUNTIME,
        defaultEffort: DEFAULT_EFFORT,
      });
    }

    return serveStatic(req, res, p);
  } catch (e) {
    return sendJSON(res, 500, { error: String(e?.message || e) });
  }
});

// ---------------------------------------------------------------------------
// SSE broadcast loop — files are cheap, the CLI is not, so they tick apart.
// ---------------------------------------------------------------------------
/* ONLY WHAT MOVED GOES DOWN THE WIRE.

   The feed used to ship every agent every 1.5 seconds, because ANY byte in the
   list had changed. Measured on this fleet: 502 agents, 1.41 MB per tick — of
   which ONE agent, 1.0 KB, had actually moved. The browser paid for the other
   1.44 MB twice, once parsing it and once collecting 502 fresh objects, on the
   same thread that is meant to be accepting clicks.

   A delta has to be provably in step, so every broadcast carries a sequence
   number: a client exactly one behind gets the difference, anyone else (a new
   connection, a client that missed one) gets the whole list. The browser checks
   the same number and re-fetches if it ever does not add up — a delta applied
   to the wrong base shows agents that no longer exist, which is worse than a
   slow feed. */
let feedSeq = 1;
let feedTick = 0;
const FEED_FULL_EVERY = 20;          // ticks — 30 seconds
const feedPrev = new Map();          // key -> the JSON last sent for it
const feedKey = (a) => a.id || ('sess:' + a.sessionId);

setInterval(async () => {
  if (!sseClients.size) return;
  try {
    const agents = await snapshot();
    const changed = [];              // already serialised; never stringified twice
    const here = new Set();
    for (const a of agents) {
      const k = feedKey(a); here.add(k);
      const j = JSON.stringify(a);
      if (feedPrev.get(k) !== j) { feedPrev.set(k, j); changed.push(j); }
    }
    const gone = [];
    for (const k of feedPrev.keys()) if (!here.has(k)) { gone.push(k); feedPrev.delete(k); }

    const moved = changed.length > 0 || gone.length > 0;
    if (moved) feedSeq++;
    /* THE WHOLE LIST, TWICE A MINUTE, WHATEVER HAPPENED. Three jobs in one
       line: it bounds how far a client can drift from the truth if a delta is
       ever wrong, it is the shape an older page still understands (the `agents`
       event has kept its plain-array body — the sequence number rides in the
       SSE `id:` field, which a browser that does not look for it ignores), and
       it costs 1.4 MB per 30 seconds instead of per 1.5. */
    const resync = (feedTick++ % FEED_FULL_EVERY) === 0;
    let full = null, delta = null;
    for (const c of sseClients) {
      if (c.seq === feedSeq && !resync) continue;          // already holds this state
      if (c.seq === feedSeq - 1 && moved && !resync) {
        delta ??= `{"changed":[${changed.join(',')}],"gone":${JSON.stringify(gone)}}`;
        c.res.write(`id: ${feedSeq}\nevent: agents-delta\ndata: ${delta}\n\n`);
      } else {
        full ??= JSON.stringify(agents);
        c.res.write(`id: ${feedSeq}\nevent: agents\ndata: ${full}\n\n`);
      }
      c.seq = feedSeq;
    }
  } catch {}
}, 1500);

/* A REAL event, not a `:comment`. EventSource swallows comments entirely, so a
   browser cannot tell "nothing changed" (normal — the agents payload is only
   sent on change) from "this stream is a corpse". A named ping gives the client
   a heartbeat it can time out on. */
setInterval(() => {
  const line = `event: ping\ndata: ${Date.now()}\n\n`;
  for (const c of sseClients) { try { c.res.write(line); } catch {} }
}, 15000);

/* Keeps watching while no browser is open, so an agent that finishes overnight
   is unread in the morning. Slow on purpose — `claude agents --json` costs
   ~0.3s, and nobody is looking. */
setInterval(() => { if (!sseClients.size) snapshot().catch(() => {}); }, 12000);

/* Once a minute, browser or not — an agent that finishes at 2 a.m. should not
   hold its half gigabyte until you open the dashboard. The rule is minutes
   long, so a minute of lateness is noise; the first tick waits a full minute so
   a server restart never stops anything before the lanes have settled. */
setInterval(() => { autoStopRun().catch(() => {}); }, 60000);
/* Browser or not: the limit has to hold at 3 a.m. too. */
setInterval(() => { refreshBedrockBudget().catch((e) => console.log(`  BUDGET      error: ${e?.message || e}`)); }, BUDGET_TICK);

// ---------------------------------------------------------------------------
// PTY — a real terminal running real `claude attach`. The human types into it.
// ---------------------------------------------------------------------------
// The terminal is the most dangerous door in the house: whoever holds the
// socket types into a live agent. Same rule as every HTTP request above.
const wss = new WebSocketServer({ server, path: '/pty', verifyClient: ({ req }) => fromThisPage(req) });

wss.on('connection', (ws, req) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  const id = u.searchParams.get('id') || '';
  const cols = Math.max(40, Math.min(400, Number(u.searchParams.get('cols') || 120)));
  const rows = Math.max(10, Math.min(200, Number(u.searchParams.get('rows') || 32)));

  if (!SHORT_ID.test(id) || !CLAUDE_BIN) {
    ws.send(JSON.stringify({ t: 'fatal', msg: 'invalid session id, or claude not found' }));
    ws.close();
    return;
  }

  let term;
  try {
    term = pty.spawn(CLAUDE_BIN, ['attach', id], {
      name: 'xterm-256color',
      cols, rows,
      cwd: HOME,
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '3' },
    });
  } catch (e) {
    ws.send(JSON.stringify({ t: 'fatal', msg: 'PTY could not start: ' + e.message }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ t: 'started', cmd: `claude attach ${id}`, pid: term.pid }));
  term.onData((d) => { try { ws.send(d); } catch {} });
  term.onExit(({ exitCode }) => {
    try { ws.send(JSON.stringify({ t: 'exit', code: exitCode })); ws.close(); } catch {}
  });

  ws.on('message', (raw, isBinary) => {
    const s = isBinary ? raw.toString('utf8') : raw.toString('utf8');
    if (s.startsWith('\x00resize:')) {
      const [c, r] = s.slice(8).split(',').map(Number);
      if (c > 0 && r > 0) { try { term.resize(Math.min(400, c), Math.min(200, r)); } catch {} }
      return;
    }
    try { term.write(s); } catch {}
  });

  // Closing the panel detaches. Per Claude Code's own contract, detaching never
  // stops a background session.
  ws.on('close', () => { try { term.kill(); } catch {} });
});

/* THE SAME SEND, WITHOUT A BROWSER.
 *
 * A reply from the phone must not be a second way of talking to an agent —
 * it is the dashboard's Send button, run here. Same `claude attach`, same
 * wait for the drawn prompt, same bracketed paste, same Enter. The wait is
 * the whole trick: `claude attach` prints "Attaching…" seconds before it can
 * hear anything, and text typed into that window is lost without a trace.
 * The `❯` is the first thing that means someone is listening.
 */
function sendToAgent(id, text) {
  return new Promise((resolve) => {
    if (!SHORT_ID.test(id || '')) return resolve({ ok: false, error: 'invalid id' });
    if (!CLAUDE_BIN) return resolve({ ok: false, error: 'claude not found' });
    const body = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!body) return resolve({ ok: false, error: 'empty text' });

    let term = null, done = false, ready = false, seen = '';
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(hardStop);
      try { term?.kill(); } catch {}
      resolve(r);
    };
    const hardStop = setTimeout(() => finish({ ok: false, error: 'Timeout — the prompt did not arrive' }), 30000);

    try {
      term = pty.spawn(CLAUDE_BIN, ['attach', id], {
        name: 'xterm-256color', cols: 120, rows: 32, cwd: HOME,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) { return finish({ ok: false, error: 'PTY: ' + e.message }); }

    term.onExit(() => finish({ ok: false, error: 'Session is gone' }));
    term.onData((d) => {
      if (ready) return;
      seen += d;
      if (!seen.includes('❯')) return;
      ready = true;
      // CR would submit at every line break; LF is a newline inside the prompt.
      term.write('\x1b[200~' + body + '\x1b[201~');
      // The paste must land as one block before Enter follows on the same pipe.
      setTimeout(() => { try { term.write('\r'); } catch {} }, 250);
      // And Enter must reach the daemon before we detach out from under it.
      setTimeout(() => finish({ ok: true }), 1500);
    });
  });
}

/** What the phone's reply actually does. Answering is reading, so the unread
 *  mark comes off here too — otherwise every reply sent from the phone leaves a dot. */
async function routeReply(id, text) {
  const a = (await snapshot()).find((x) => x.id === id);
  if (!a) return { ok: false, error: 'no agent with #' + id };
  const r = await sendToAgent(id, text);
  if (r.ok) {
    const u = await getUi();
    delete u.unread[a.id || ('sess:' + a.sessionId)];
    saveUi();
    agentsCache.at = 0;
  }
  return { ...r, name: a.name || id };
}

/* The restart button. The successor is a detached shell that outlives us: it
   waits until this pid is gone (so the port is free), capped at 15 s so a
   process stuck in exit can never leave it waiting forever, then execs the
   same node with the same argv, env and log. */
let restarting = false;
function restartSelf() {
  if (restarting) return;
  restarting = true;
  const logPath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), 'flotilla.log');
  const out = fs.openSync(logPath, 'a');
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const cmd = `i=0; while kill -0 ${process.pid} 2>/dev/null && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done; ` +
    `echo "  restart     $(date '+%H:%M:%S') (was pid ${process.pid})"; ` +
    `exec ${[process.execPath, ...process.argv.slice(1)].map(q).join(' ')}`;
  const child = spawn('/bin/sh', ['-c', cmd], {
    cwd: process.cwd(), env: process.env, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  console.log('  restart     requested from the UI');
  flushStateSync();
  // Give the 200 a moment to leave the socket, then go — without waiting on
  // open WebSockets / PTYs, which would hold the port indefinitely.
  setTimeout(() => process.exit(0), 300);
}

/* UI state and drafts are written 400 ms after the last change. Exiting inside
   that window — the restart button waits 300 ms, a `kill` waits for nothing —
   dropped the last thing you typed or arranged. Written out synchronously on
   every way out we get told about. (Not SIGHUP: `nohup` ignores it on purpose,
   and a handler would undo that the moment the terminal closes.) */
function flushStateSync() {
  const w = (file, obj) => {
    try { const tmp = file + '.exit.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8'); fs.renameSync(tmp, file); } catch {}
  };
  if (ui) { clearTimeout(uiFlush); w(UI_FILE, ui); }
  if (draftsCache) { clearTimeout(draftFlush); w(DRAFTS_FILE, draftsCache); }
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { flushStateSync(); process.exit(0); });

snapshotState();
setInterval(snapshotState, 3600e3).unref();

// ---------------------------------------------------------------------------
const banner = () => {
  console.log('');
  console.log('  flotilla');
  console.log('  ────────────────────────────────────────────');
  console.log(`  UI          http://${HOST}:${PORT}`);
  console.log(`  claude      ${CLAUDE_BIN || 'NOT FOUND — actions disabled'}`);
  console.log(`  reads       ${JOBS_DIR}`);
  console.log(`              ${PROJECTS_DIR}`);
  console.log(`  writes      ${DATA_DIR}  (drafts, usage index, read/archive state)`);
  console.log('              never ~/.claude — actions run as `claude …`');
  console.log('');
};

/* Printed after the key check so the answer to "why is DeepSeek greyed out"
   is on screen before you go looking for it in the UI. */
async function runtimeBanner() {
  for (const r of runtimeCatalogue(await runtimeKeys())) {
    let where = '';
    if (r.id === 'bedrock' && r.ready) {
      /* Which region and profile family the credits are spent in — the one
         thing a wrong bedrock.json gets silently wrong. */
      const cfg = await readJson(path.join(DATA_DIR, 'bedrock.json'), null);
      const region = String(cfg?.region || '').trim() || RUNTIMES.bedrock.defaultRegion;
      where = ` (${region}, ${String(cfg?.profilePrefix || '').trim() || bedrockPrefixFor(region)}.anthropic.*)`;
    }
    console.log(`  runtime     ${r.label.padEnd(10)} ${r.ready ? 'ready' + where : r.reason}`);
  }
  const b = await refreshBedrockBudget().catch(() => null);
  if (b?.limitUsd > 0) console.log(`  budget      Claude · AWS ${usd(b.spentUsd)} / ${usd(b.limitUsd)} (${b.pct.toFixed(1)} %)${b.exhausted ? ' — EXHAUSTED' : ''}`);
  console.log('');
}

runtimeBanner();
/* Outbound only: this opens connections TO ntfy, it never opens a port. The
   server keeps binding 127.0.0.1 — the phone reaches your agents without
   anything on this machine becoming reachable from the internet. */
startPush(DATA_DIR, routeReply);
resolveClaude().then((bin) => {
  CLAUDE_BIN = bin;
  server.listen(PORT, HOST, banner);
});
