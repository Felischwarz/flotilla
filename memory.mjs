/* MEMORY — what this machine spends its RAM on, in the fleet's own words.

   Why this exists: a Mac "lags at 8 GB of agents" when everything together
   wants far more than it has — browser, editor and agent trees side by side —
   and whatever does not fit lives compressed or on disk (swap).
   Activity Monitor answers "which process"; the question here is "which KIND of
   thing", because the levers are kinds: stop finished agents, close a browser,
   kill a forgotten test Chrome.

   Three sources, three prices:
     vm_stat + sysctl   ~20 ms   the machine's own split of physical RAM
     ps                 ~0.7 s   the process tree (who started whom), at load 75
     top -l 1           ~8 s     the physical FOOTPRINT per process, at load 75

   RSS (what `ps` reports) is the wrong number under pressure: a page that was
   compressed or swapped out is no longer resident, so the programs that hurt
   most look the smallest. The footprint counts those pages too — it is what
   Activity Monitor's "Memory" column shows — and it costs `top`. So `top` runs
   only while somebody is looking at the panel, at most every 20 seconds, and
   the answer everybody gets is the last one it produced (stale while
   revalidate, the same rule as `claude agents --json` in server.mjs).

   READ-ONLY. Nothing in here kills, signals or renices anything. */
import { execFile } from 'node:child_process';

export const GiB = 1024 ** 3;
const UNIT = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

const run = (cmd, args, timeout = 30000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
});

// ---------------------------------------------------------------------------
// SYSTEM — the split Activity Monitor draws at the bottom of its Memory tab.
//   used  = app + wired + compressed   (what cannot be dropped without cost)
//   cache = file-backed + purgeable    (what macOS drops for free)
// `squeezed` is how much the compressor is HOLDING, `compressed` what it
// OCCUPIES; the ratio of the two is why a machine can carry more demand than
// it has RAM at all.
// ---------------------------------------------------------------------------
let sysCache = { at: 0, data: null };
export async function systemMemory(maxAgeMs = 5000) {
  if (sysCache.data && Date.now() - sysCache.at < maxAgeMs) return sysCache.data;
  const [vm, sc] = await Promise.all([
    run('/usr/bin/vm_stat', []),
    run('/usr/sbin/sysctl', ['-n', 'hw.memsize', 'vm.swapusage', 'kern.memorystatus_vm_pressure_level']),
  ]);
  if (!vm || !sc) return sysCache.data;
  const page = Number(vm.match(/page size of (\d+) bytes/)?.[1] || 16384);
  const pg = (label) => Number(vm.match(new RegExp(label + ':\\s+(\\d+)'))?.[1] || 0) * page;
  const [memsize, swap = '', pressure] = sc.trim().split('\n');
  const swapOf = (k) => {
    const m = swap.match(new RegExp(k + ' = ([\\d.]+)([KMG])'));
    return m ? Number(m[1]) * UNIT[m[2]] : 0;
  };
  const total = Number(memsize) || 0;
  const app = Math.max(0, pg('Anonymous pages') - pg('Pages purgeable'));
  const wired = pg('Pages wired down');
  const compressed = pg('Pages occupied by compressor');
  const cached = pg('File-backed pages') + pg('Pages purgeable');
  const used = app + wired + compressed;
  const data = {
    at: Date.now(), total, app, wired, compressed, cached, used,
    squeezed: pg('Pages stored in compressor'),
    free: Math.max(0, total - used - cached),
    swapTotal: swapOf('total'), swapUsed: swapOf('used'),
    // 1 normal · 2 warn · 4 critical — the kernel's own verdict, not a threshold of ours
    pressure: Number(pressure) || 0,
  };
  sysCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------------------
// PROCESS TABLE — cheap enough for the auto-stop tick, which needs it for one
// thing: who has an agent open in a terminal right now (`claude attach <id>`).
// ---------------------------------------------------------------------------
let psCache = { at: 0, list: null, inflight: null };
export async function processTable(maxAgeMs = 10000) {
  if (psCache.list && Date.now() - psCache.at < maxAgeMs) return psCache.list;
  psCache.inflight ??= run('/bin/ps', ['-axo', 'pid=,ppid=,user=,rss=,command='])
    .then((out) => {
      if (!out) return;
      psCache.list = out.split('\n').map((line) => {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], user: m[3], rss: +m[4] * 1024, cmd: m[5] };
      }).filter(Boolean);
      psCache.at = Date.now();
    })
    .finally(() => { psCache.inflight = null; });
  await psCache.inflight;
  return psCache.list || [];
}

/** The executable's own name. Paths with spaces (Google Chrome.app) come out
 *  wrong here, which is fine: nothing below identifies a browser by it. */
const exe = (cmd) => (cmd.split(' ')[0] || '').split('/').pop();
const isClaude = (p) => exe(p.cmd) === 'claude';

/** Agents someone is looking at in a terminal — the fleet's own panes AND a
 *  real terminal. Stopping one of those would pull it out from under a human. */
export function attachedIds(table) {
  const out = new Set();
  for (const p of table) {
    if (!isClaude(p)) continue;
    const m = p.cmd.match(/\sattach\s+([0-9a-f]{8})\b/);
    if (m) out.add(m[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GROUPS — decided by ANCESTRY, not by name. A tsx process is an agent's test
// when an agent started it and a forgotten dev server when nobody did; a Chrome
// is your browser unless a node script launched it for a screenshot.
// Order is the order of the bar, left to right: the part the fleet controls
// first, macOS last.
// ---------------------------------------------------------------------------
export const GROUPS = [
  { id: 'agents', label: 'Claude agents' },
  { id: 'tools', label: 'Agent tools' },      // shells, tests, MCP servers, dev servers, test browsers
  { id: 'chrome', label: 'Chrome' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'other', label: 'Other apps' },
  { id: 'system', label: 'macOS' },
];
const isChrome = (p) => p.cmd.includes('Google Chrome') || p.cmd.includes('Chromium');
const isCursor = (p) => p.cmd.includes('/Cursor.app/');
const isDevTool = (p) => /^(node|tsx|npm|npx|vite|esbuild|bun|deno)$/.test(exe(p.cmd));
const isSystem = (p) => p.pid === 0 || p.user === 'root' || p.user.startsWith('_');

function classify(p, byPid, selfPid) {
  if (isClaude(p) || p.pid === selfPid) return 'agents';
  let cur = p;
  for (let hop = 0; cur && hop < 64; hop++) {
    if (hop > 0 && isClaude(cur)) return 'tools';
    if (isChrome(cur)) {
      // a Chrome whose parent chain holds node or claude is somebody's puppeteer
      for (let up = byPid.get(cur.ppid), h = 0; up && h < 64; up = byPid.get(up.ppid), h++) {
        if (isClaude(up) || isDevTool(up)) return 'tools';
        if (up.pid <= 1) break;
      }
      return 'chrome';
    }
    if (isCursor(cur)) return 'cursor';
    if (cur.pid <= 1) break;
    cur = byPid.get(cur.ppid);
  }
  for (let up = p, h = 0; up && h < 64; up = byPid.get(up.ppid), h++) {
    if (isDevTool(up)) return 'tools';
    if (up.pid <= 1) break;
  }
  return isSystem(p) ? 'system' : 'other';
}

/** A name a human recognises in a tooltip: the script, not `node`. */
function prettyName(p, agentName) {
  if (agentName) return agentName;
  const c = p.cmd;
  if (isClaude(p)) {
    if (/\sdaemon\b/.test(c)) return 'Claude daemon';
    if (/bg-pty-host/.test(c)) return 'Claude terminal host';
    if (/\sattach\s/.test(c)) return 'claude attach';
    if (/bg-spare/.test(c)) return 'Claude (warm spare)';
    return 'claude';
  }
  const helper = c.match(/Google Chrome Helper(?: \(([^)]+)\))?/);
  if (helper) return `Chrome ${helper[1] || 'helper'}`;
  /* The LAST script outside node_modules: tsx starts node as
     `node --require …/tsx/dist/preflight.cjs … app.test.ts`, and the
     first match would name every test run in the fleet "preflight.cjs". */
  if (isDevTool(p)) {
    const scripts = c.split(/\s+/).filter((t) => /\.(m?ts|m?js|cjs|py)$/.test(t) && !t.includes('node_modules'));
    if (scripts.length) return scripts.at(-1).split('/').pop();
  }
  const app = c.match(/\/([^/]+)\.app\/Contents\/MacOS\/([^/]+?)(?:\s|$)/);
  if (app) return app[1].startsWith(app[2]) ? app[1] : `${app[1]} · ${app[2]}`;
  return exe(c) || String(p.pid);
}

let procCache = { at: 0, ms: 0, data: null, inflight: null };

/**
 * The last process sample, and a new one started if it is older than
 * `maxAgeMs`. Returns null until the very first `top` has come back — the
 * caller shows "measuring" rather than waiting 8 seconds on a request.
 * `agents` is `[{ pid, name }]` from `claude agents --json`: a sample is only
 * as fresh as the list it was attributed with, which is why it rides along.
 */
export function processMemory({ agents = [], selfPid = 0, maxAgeMs = 20000 } = {}) {
  const stale = !procCache.data || Date.now() - procCache.at > maxAgeMs;
  if (stale && !procCache.inflight) {
    procCache.inflight = sampleProcesses(agents, selfPid)
      .then((data) => { if (data) procCache = { ...procCache, at: Date.now(), data }; })
      .catch(() => {})
      .finally(() => { procCache.inflight = null; });
  }
  return procCache.data ? { ...procCache.data, sampling: Boolean(procCache.inflight) } : null;
}

/** Bytes an agent held at the last sample, for the auto-stop log. Null when
 *  nobody has opened the panel lately — an old number would be a wrong one. */
export function lastAgentBytes(pid, maxAgeMs = 10 * 60000) {
  if (!procCache.data || Date.now() - procCache.at > maxAgeMs) return null;
  return procCache.data.agentBytes[pid] ?? null;
}

async function sampleProcesses(agents, selfPid) {
  const t0 = Date.now();
  const [topOut, table] = await Promise.all([
    run('/usr/bin/top', ['-l', '1', '-stats', 'pid,mem', '-o', 'mem'], 60000),
    processTable(0),
  ]);
  if (!table.length) return null;

  const foot = new Map();
  if (topOut) {
    let on = false;
    for (const line of topOut.split('\n')) {
      if (/^PID\s+MEM/.test(line)) { on = true; continue; }
      if (!on) continue;
      const m = line.match(/^(\d+)\*?\s+([\d.]+)([BKMGT])/);
      if (m) foot.set(+m[1], Number(m[2]) * UNIT[m[3]]);
    }
  }
  // A process `top` did not list falls back to RSS: an undercount, never a zero.
  const bytesOf = (p) => foot.get(p.pid) ?? p.rss;

  const byPid = new Map(table.map((p) => [p.pid, p]));
  const kids = new Map();
  for (const p of table) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p);
  }
  const agentName = new Map(agents.filter((a) => a.pid).map((a) => [a.pid, a.name || a.id || null]));

  const groups = Object.fromEntries(GROUPS.map((g) => [g.id, { ...g, bytes: 0, procs: 0, names: new Map() }]));
  let total = 0;
  for (const p of table) {
    const b = bytesOf(p);
    const g = groups[classify(p, byPid, selfPid)];
    g.bytes += b; g.procs++; total += b;
    const n = prettyName(p, agentName.get(p.pid));
    g.names.set(n, (g.names.get(n) || 0) + b);
  }

  /* An agent is its `claude` process, the terminal host that owns it and
     everything it started — MCP servers, shells, test runs, browsers. That is
     exactly what `claude stop` gives back, so it is what the panel promises. */
  const agentBytes = {};
  for (const a of agents) {
    const root = byPid.get(a.pid);
    if (!root) continue;
    let sum = 0;
    const host = byPid.get(root.ppid);
    if (host && /bg-pty-host/.test(host.cmd)) sum += bytesOf(host);
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const p = stack.pop();
      if (seen.has(p.pid)) continue;
      seen.add(p.pid);
      sum += bytesOf(p);
      for (const k of kids.get(p.pid) || []) stack.push(k);
    }
    agentBytes[a.pid] = sum;
  }

  return {
    at: Date.now(),
    ms: Date.now() - t0,
    footprint: foot.size > 0,        // false = `top` failed and every number is RSS
    total,
    groups: GROUPS.map(({ id }) => {
      const g = groups[id];
      const top = [...g.names].sort((x, y) => y[1] - x[1]).slice(0, 4).map(([name, bytes]) => ({ name, bytes }));
      return { id, label: g.label, bytes: g.bytes, procs: g.procs, top };
    }),
    agentBytes,
  };
}
