/* flotilla frontend.
   Holds no truth of its own: it renders whatever the server read out of Claude
   Code's files, and every action is one server call that runs one `claude`
   command. Nothing here decides what an agent "really" is. */

const $ = (s) => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t); if (c) n.className = c; if (x != null) n.textContent = x; return n; };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* Two icons are DRAWN, not typed. The envelope codepoint (U+2709) renders as a
   colour emoji on macOS, as a plain glyph on Windows and as a missing-glyph box
   on some Linux builds — a button whose meaning depends on the machine's font
   stack is exactly the surprise this dashboard is meant not to have. */
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};
const svgIcon = (cls, kids) => {
  const s = svgEl('svg', { class: cls, viewBox: '0 0 20 20', width: 13, height: 13, 'aria-hidden': 'true', focusable: 'false' });
  for (const k of kids) s.appendChild(k);
  return s;
};
/* Gmail's rule, because everyone already knows it: FILLED = unread, outline =
   read. The old glyphs (○ when unread, ● when read) showed the ACTION instead
   of the state, so the button contradicted the row it sat in — that is what
   made it unreadable, not the shape. Same envelope either way, so the only
   thing your eye has to compare is "solid or not". */
const mailIcon = (unread) => svgIcon('ico-mail' + (unread ? ' full' : ''), [
  svgEl('rect', { x: 2.5, y: 5, width: 15, height: 10, rx: 1.7,
    fill: unread ? 'currentColor' : 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
  // the fold, drawn dark ON the fill so it survives whatever the button sits on
  svgEl('path', { d: 'M3.7 6.3 L10 11 L16.3 6.3', fill: 'none',
    stroke: unread ? 'rgba(0,0,0,.55)' : 'currentColor',
    'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
]);
/* A small screen with an even smaller one floating in its corner — the picture
   of what the button does, which "⧉" next door already spends on a new tab. */
/* A thumbtack, filled when the chat IS pinned and hollow when the button would
   pin it — the same read as the envelope beside it: solid means the mark is on. */
const pinIcon = (on) => svgIcon('ico-pin' + (on ? ' full' : ''), [
  svgEl('circle', { cx: 10, cy: 6.2, r: 3.6, fill: on ? 'currentColor' : 'none',
    stroke: 'currentColor', 'stroke-width': 1.5 }),
  svgEl('path', { d: 'M5.6 10.6 H14.4 M10 10.6 V17.6', fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
]);
const monitorIcon = () => svgIcon('ico-monitor', [
  svgEl('rect', { x: 1.6, y: 3.2, width: 16.8, height: 11.6, rx: 1.6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
  svgEl('path', { d: 'M7 17.4 H13', stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round' }),
  svgEl('rect', { x: 9.6, y: 8.4, width: 7, height: 5, rx: 1, fill: 'currentColor' }),
]);
const locateIcon = () => svgIcon('ico-locate', [
  svgEl('circle', { cx: 10, cy: 10, r: 4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
  svgEl('circle', { cx: 10, cy: 10, r: 1.3, fill: 'currentColor' }),
  svgEl('path', { d: 'M10 2.2 V4.6 M10 15.4 V17.8 M2.2 10 H4.6 M15.4 10 H17.8',
    stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round' }),
]);

let AGENTS = [];
let PREV = new Map();
let PREV_UNREAD = new Map();     // key -> was it unread last time we looked
let META = { cwds: [], runtimes: [], defaultRuntime: 'claude' };

/* ------------------------------------------------------------ workspaces */
/* ONE WINDOW, ONE FOLDER. `?ws=` names the workspace (none = "main"); the
   server says which folder it is about. That folder decides what the list
   shows, where a new agent starts and what "mark all read" touches. Drafts,
   unread marks, pins and the archive belong to the AGENT — and an agent lives
   in exactly one folder — so none of them needs a per-workspace copy.
   `ALL_FOLDERS` is the way out when you want to see everything anyway. */
const WS = new URLSearchParams(location.search).get('ws') || 'main';
const TAB_ID = Math.random().toString(36).slice(2, 10);
let WSINFO = null;          // { root, title, … } of THIS window, from the server
let ROOT = '';              // '' until loaded = no filter, never "nothing"
let ALL_FOLDERS = false;
let WS_LIST = null;         // GET /api/workspaces: every workspace + the folders agents work in
let WS_ERR = '';            // set when this window could not load its desk
const underRoot = (cwd, root) => !root || !cwd || cwd === root || String(cwd).startsWith(root.endsWith('/') ? root : root + '/');
const inWorkspace = (a) => ALL_FOLDERS || underRoot(a.cwd, ROOT);
/** Where a new agent starts: this workspace's folder. */
const defaultCwd = () => ROOT || META.cwds?.[0] || '';
const baseName = (p) => String(p || '').replace(/\/+$/, '').split('/').pop() || p || '';
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
/** The folder's name — plus the workspace's own name when two could share it
 *  ("my-app (w2)"), so the tab strip and the list can tell them apart. */
const wsLabel = (info = WSINFO, name = WS) => {
  if (info?.title) return info.title;
  const b = baseName(info?.root) || name;
  return name === 'main' || name === slugOf(b) ? b : `${b} (${name})`;
};
function setWsInfo(info) {
  WSINFO = info || null;
  ROOT = WSINFO?.root || '';
  ALL_FOLDERS = Boolean(WSINFO?.allFolders);
  paintWsChip();
}

/* The runtime list comes from the server (see runtimes.mjs). The fallback is
   deliberately the native one only: inventing a provider entry here is exactly
   the second copy that file exists to prevent — it would offer DeepSeek in the
   dropdown on a machine where the server never heard of it. */
const RUNTIMES = () => (META.runtimes?.length ? META.runtimes : [{ id: 'claude', label: 'Claude', models: ['opus', 'sonnet', 'haiku', 'fable'], ready: true, reason: '' }]);
const runtimeById = (id) => RUNTIMES().find((r) => r.id === id) || RUNTIMES()[0];

/* The runtime you CHOSE last is the suggestion for the next pane. A default
   that snaps back on every new pane is not a default but a trap: the choice
   looks made, because you made it once. */
const lastRuntime = () => {
  try { const v = localStorage.getItem('fleet.runtime'); if (v && runtimeById(v)?.ready) return v; } catch {}
  return META.defaultRuntime || 'claude';
};
const rememberRuntime = (id) => { try { localStorage.setItem('fleet.runtime', id); } catch {} };
const PD = new Map();            // key -> pane runtime state
let SOUND = localStorage.getItem('fleet.sound') !== 'off';
let BOOTED = false;
let TICK = 0;
/* NOT a limit any more, and nothing enforces it. Panes used to be evicted from
   the left once you passed it, which is how open views "closed by themselves" —
   with a compose pane that was the only reference to a half-written idea, so
   the text became unreachable. The strip is a workspace: it only ever loses a
   pane because you closed that pane. Kept as the number where a strip starts
   feeling crowded, and as the reason RAM grows if you never tidy up. */
const MAX_PANES = 8;
let PREFS = { sort: 'recent', group: 'none', layout: 'columns', archiveStops: true, pinsTop: true, collapsed: {} };
let ARCHIVE_VIEW = false;
let FOCUSED = null;          // which pane the cursor is in

/* ONE PASS PER FRAME — AND THE CLICK GOES FIRST.

   The two expensive passes (the sidebar and the pane strip) used to be called
   straight out of every event that could change them: a keystroke in a draft
   box, a pointerdown in a pane, every agents payload, every click on a row.
   Measured on this fleet — 516 agents, 430 rows, 6 panes — a list pass is 13ms
   of script plus the style and layout the browser then owes for it, and a pane
   pass was 420ms. Three events in one frame paid for all three passes.

   Nothing runs a pass any more; everything ASKS for one. The frame collapses
   them into a single pass, and — this is the half that was actually being
   complained about — the browser gets to paint the result of your click before
   any of it runs. The action is instant, the bookkeeping follows it. */
let listQueued = false, panesQueued = false;
function scheduleList() {
  if (listQueued) return;
  listQueued = true;
  requestAnimationFrame(() => { listQueued = false; renderList(); });
}
function schedulePanes() {
  if (panesQueued) return;
  panesQueued = true;
  requestAnimationFrame(() => { panesQueued = false; renderPanes(); });
}

/* Moving the cursor from one pane to another changes exactly TWO rows: the one
   losing the focus ring and the one getting it. Repainting 430 rows to move a
   border was 13ms plus a full style recalculation on every click into a pane. */
function setFocus(key) {
  if (FOCUSED === key) return;
  const was = FOCUSED;
  FOCUSED = key;
  if (was) patchRow(was);
  if (key) patchRow(key);
}

function savePrefs() {
  fetch('/api/prefs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefs: PREFS }) }).catch(() => {});
}

/* WHAT YOU JUST CLICKED OUTRANKS WHAT THE SERVER LAST SAID.

   Every action here is optimistic, and the feed is 1.5 seconds wide: the
   payload that answers your click was computed BEFORE it, so applying it
   verbatim un-archives the row you just archived and it flickers back under
   your cursor — with the next click landing on the wrong agent. So a click
   writes an override that survives incoming payloads until the server agrees
   (or until it clearly never will). */
const OVERRIDE = new Map();          // key -> { archived?, unread?, at }
const OVERRIDE_TTL = 20000;
function override(key, patch) {
  const cur = OVERRIDE.get(key) || {};
  OVERRIDE.set(key, { ...cur, ...patch, at: Date.now() });
  const a = findAgent(key);
  if (a) { Object.assign(a, patch); SIG_SELF.delete(a); }   // the record moved under its cached signature
  /* The sound follows the edge into unread (see detectTransitions), and YOUR
     click is not that edge — marking a row unread by hand would otherwise ring
     on the next payload, as if the agent had just finished. */
  if (patch.unread !== undefined) PREV_UNREAD.set(key, Boolean(patch.unread));
}
/* Applied to every payload before anything looks at it. An override retires as
   soon as the server says the same thing — anything else would make a stale
   click permanent. */
function applyOverrides(list) {
  if (!OVERRIDE.size) return list;
  const now = Date.now();
  for (const a of list) {
    const o = OVERRIDE.get(keyOf(a));
    if (!o) continue;
    let agrees = true;
    for (const f of ['archived', 'unread', 'pinned']) {
      if (o[f] === undefined) continue;
      if (Boolean(a[f]) !== o[f]) { a[f] = o[f]; agrees = false; SIG_SELF.delete(a); }
    }
    if (agrees || now - o.at > OVERRIDE_TTL) OVERRIDE.delete(keyOf(a));
  }
  return list;
}

/* Unread, like mail. The server owns the flag because an agent that finishes
   while this page is closed still has to be unread when you come back. */
function markRead(key) {
  const a = findAgent(key);
  if (!a?.unread) return;
  override(key, { unread: false });                  // optimistic, so the UI never lags a click
  fetch('/api/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, unread: false }) }).catch(() => {});
  patchRow(key);
}
function markUnread(key) {
  override(key, { unread: true });
  fetch('/api/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, unread: true }) }).catch(() => {});
  patchRow(key); updateAmbient();
}
const TERMINAL = new Set(['done', 'failed', 'stopped', 'idle']);
/* NOT awaited anywhere. Archiving a finished agent also runs `claude stop` on
   the server, which takes seconds — long enough that archiving ten agents in a
   row used to mean ten waits, each one with the list frozen on rows that were
   already gone. The screen is right immediately; the request is a background
   errand that only ever comes back to print the command it ran. */
function setArchived(key, archived) {
  const a = findAgent(key);
  // Stopping frees the measured ~460 MB, but only a FINISHED agent's process is
  // pure waste. Archiving something mid-run must never kill it.
  const stop = Boolean(archived && PREFS.archiveStops && a?.alive && a?.id && TERMINAL.has(lane(a)));
  override(key, archived ? { archived: true, unread: false } : { archived: false });
  if (archived && locate(key)) closePane(key);       // renders the list itself
  else { scheduleList(); updateAmbient(); }
  fetch('/api/archive', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, archived, stop }),
  }).then((r) => r.json()).then((r) => { if (r?.cmd) logCmd(r); }).catch(() => {});
}

/* PINNED = "I am coming back to this one." It is the one mark that outranks the
   sort: a pinned chat is drawn at the very top and stays there while you work
   somewhere else, so leaving a conversation can no longer lose it.

   It is NOT a second archive. The agent keeps its lane, its unread mark and its
   place in every filter — the pin decides only WHERE the row is drawn. And it
   lives on the server (like unread and archived), because a pin that a reload
   forgets is not a pin. */
function setPinned(key, pinned) {
  /* `pinnedAt` comes along optimistically because it is the SORT KEY of the top
     group: without it the row you just pinned has no timestamp until the next
     payload, sorts as if it were pinned in 1970, and lands UNDER the pin you
     set a minute ago — for 1.5 seconds, under your cursor. The server's own
     value overwrites it on the next payload; they agree to the millisecond. */
  override(key, { pinned, pinnedAt: pinned ? Date.now() : null });
  fetch('/api/pin', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, pinned }),
  }).catch(() => {});
  /* The pin moves the row to another place in the list, so this is a full pass,
     not a patchRow — and the open pane repaints because its own chrome carries
     the mark too. Both are asked for, not run: the pin has to look pressed in
     THIS frame, and neither of those two answers the click. */
  scheduleList();
  if (locate(key)) updatePane(key);
}

function dotsEl() { const w = el('span', 'dots'); for (let i = 0; i < 3; i++) w.appendChild(el('span')); return w; }

function ago(t) {
  if (!t) return '';
  const ms = Date.now() - (typeof t === 'number' ? t : Date.parse(t));
  if (!isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}
const short = (p) => !p ? '' : p.replace(/^\/Users\/[^/]+\//, '~/');
const keyOf = (a) => a.id || ('sess:' + a.sessionId);
const findAgent = (k) => AGENTS.find((a) => keyOf(a) === k) || null;

/* ---------------------------------------------------------- traffic light */
/* The server computes the lane and ships it; this is only the fallback for a
   record that arrived without one. Keep the two identical — a second opinion
   about what "working" means is how a running agent ends up filed as Ready. */
/* A MIRROR of `laneOf` in server.mjs, which owns this rule and ships `a.lane`
   with every agent. It only runs if a payload ever arrives without one. Keep
   the two identical. */
function computeLane(a) {
  if (a.waitingFor || a.status === 'waiting') return 'needs';
  if (a.state === 'failed') return 'failed';
  if (a.stateLive) {
    if (a.state === 'blocked' && a.alive) return 'needs';
    if (a.state === 'done') return 'done';
  }
  if (a.alive && (a.status === 'busy' || (a.state === 'working' && a.tempo === 'active'))) return 'working';
  if (a.state === 'done') return 'done';
  /* A BLOCKED AGENT WITH NO PROCESS IS A FINISHED AGENT.

     `blocked` is trusted above only while the agent still HAS a pid, because
     then it is a live process asking you something right now. That left every
     agent that ended its run blocked with nowhere to go: the daemon reports it
     with no pid, so the line above cannot claim it, and `blocked` matched
     nothing further down, so it fell out of the bottom as `idle` - Ready. It is
     the opposite of ready. Measured 2026-09-13 on this fleet: 154 of 515
     agents, 30 %, sat under Ready with final reports like "tests green,
     awaiting review" and "3 tests still failing". Not one of them was ever
     marked unread, sorted up under newest
     activity, sounded or pushed, because all four of those hang off the lane
     being one that wants you - one missing rule, four silent outputs. That is
     the connection between "it finished quietly" and "it made no sound".

     `done` and not `needs`: the process is gone, so there is nothing left to
     answer, and a queue of 138 rows you cannot act on is not a queue. The run
     is over and the result wants reading, which is exactly what Done means.
     The reason it stopped is not lost - it is the detail line it carried all
     along. This is the same concession the line above makes for `done`: when
     the process is gone, the file is all there is. */
  if (a.state === 'blocked') return 'done';
  if (a.state === 'stopped') return 'stopped';
  return 'idle';
}
/* Claude Code's own footer says "2 shells still running" when a turn is over but
   background shells are not. That gap is exactly why a finished agent looked
   busy, so it is said out loud instead of being left to guess. Not shown while
   working — there it is noise; on a finished agent it is the explanation. */
const shellNote = (a) => (a.shells > 0 ? `${a.shells} shell${a.shells > 1 ? 's' : ''} running` : '');
const lane = (a) => a.lane || computeLane(a);
const LANE_LABEL = { needs: 'Needs you', failed: 'Failed', working: 'Working', done: 'Done', stopped: 'Stopped', idle: 'Ready' };
/* Ordered by what wants YOU, not by what is busy. A finished agent is waiting
   for a decision; a working one is waiting on itself and needs nothing. Done
   used to sit fourth, below Working, which buried exactly the rows you came to
   look at. */
const LANE_ORDER = { needs: 0, failed: 1, done: 2, working: 3, idle: 4, stopped: 5 };

/* IDENTITY IS TWO AXES: a colour AND a pattern.

   Colour alone does not scale. Twelve hues over hundreds of agents means every
   twelfth pane wears the same face, and those twelve sat in one narrow band of
   the wheel, so several read as "the blue one". A second, INDEPENDENT axis
   multiplies instead of adding: 15 colours × 8 patterns = 120 faces before two
   panes look alike.

   Still deliberately free of green, amber and red, because those three are the
   traffic light — an identity colour that looks like a state is worse than no
   identity colour at all. That leaves the cool half of the wheel, so the spread
   is bought with LIGHTNESS as well as hue: pale, mid and deep per family. */
const PALETTE = [
  '#67e8f9', '#22d3ee', '#0891b2', '#bae6fd', '#3b82f6', '#818cf8',
  '#4f46e5', '#c4b5fd', '#a855f7', '#f5d0fe', '#e879f9', '#c026d3',
];
/* CHOSEN BY MEASUREMENT, not by eye. Two rules decide the set:

   · at least 38° of hue from green (done), amber (needs you) and red (failed).
     A first draft broke this twice — a teal 30.6° from green painted an
     unmistakably GREEN letterhead onto a finished-looking pane, and a pink sat
     29.6° from red. Achieved: 45°.
   · no near-neutrals. Grey is already spoken for: `--rest` and `--off` mean
     "this one is idle", and an identity that reads as a state is worse than no
     identity.

   Those two leave a band of only 180°–322°, so the twelve were then picked to
   MAXIMISE the smallest perceptual distance between any two of them (redmean).
   A hand-picked list of fifteen had two entries 25 apart — two pale blues no
   one could tell apart; these twelve are never closer than 99. Fewer colours,
   each further from every other, and the pattern axis buys back the count. */
const PATTERNS = 12;
/* FNV-1a plus an avalanche step. The obvious `h*31 + c` hash collided badly
   here: agent ids are hex, and 31 mod 12 leaves the low bits barely mixed, so
   three of four agents came out the same colour. Measured before/after. */
function hashOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const idOf = (a) => a.id || a.sessionId || '';
function colorOf(a) { return PALETTE[hashOf(idOf(a)) % PALETTE.length]; }
/* A DIFFERENT seed on purpose: hashed from the same one, colour and pattern
   would move together and the second axis would buy nothing. */
function patternOf(a) { return hashOf('pattern:' + idOf(a)) % PATTERNS; }
const patClass = (a) => 'pat' + patternOf(a);

/* ------------------------------------------------------- activity phrasing */
/* No invented verbs. A rotating "Untangling…" is decoration that changes on a
   timer rather than on anything the agent did — the clock alone already says
   it is alive, and the tool name is the only word here that is a fact. */
/* THE timer. It runs from the moment your prompt went in, and from nothing
   else — the same clock Claude Code puts in its own footer ("Crunched for
   1h 36m 5s").

   It used to count from the last ACTIVITY event, so it reset to zero on every
   tool call. A turn that had been going for an hour and a half read "3s", which
   is precisely how an agent that is stuck looks like one that is thriving: the
   number was never large, no matter how long nothing happened. One clock, one
   meaning, in the row and in the pane. */
/* MEMOISED PER RECORD, because sorting asks this thousands of times: a
   500-agent sort makes ~4500 comparisons, each parsing two ISO date strings —
   measured at 12ms, the largest single item in a render pass. A WeakMap rather
   than a field on the agent, so the cache cannot travel with a copy of the
   record and cannot be seen by anything that serialises one. It cannot go
   stale either: an agent that changed arrives as a NEW object. */
const PTS = new WeakMap();
const promptStart = (a) => {
  let v = PTS.get(a);
  if (v === undefined) PTS.set(a, v = (a.lastPromptAt || Date.parse(a.updatedAt || a.createdAt || 0) || a.startedAt || 0));
  return v;
};

/* `ago()` is deliberately coarse ("4m") because in the list it answers "how long
   ago". A running turn is a STOPWATCH and needs the seconds to move, or it
   looks frozen. */
function elapsed(t) {
  if (!t) return '';
  const total = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60), s = total % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const TIMER_TITLE = 'Since your last prompt went in — not since the last tool call.';
function activityText(a) {
  const tool = a.activity?.kind === 'tool' ? a.activity.tool : null;
  const t = elapsed(promptStart(a));
  if (t && tool) return `${t} · ${tool}`;   // the clock first: it is the point
  return t || tool || '';
}

/* ------------------------------------------------------------------ sound */
/* A SLEEPING AUDIO CONTEXT SWALLOWS SOUNDS WITHOUT AN ERROR.

   A browser hands out a context that is allowed to make noise only after the
   page has been touched, and a dashboard can sit untouched on a second monitor
   for an hour before the first agent finishes. The old line was
   `if (AC.state === 'suspended') AC.resume();` and then it scheduled the notes
   regardless. Two things wrong with that, and neither of them reports itself:

   - `resume()` is a PROMISE, and before a gesture it is REJECTED. The rejection
     was dropped on the floor, the notes went into a context that was still
     asleep, and nothing in the page ever woke it again — the only other caller
     of `resume()` was the next beep, which would be rejected for the same
     reason. Every sound before the first click was lost, silently.
   - Nothing re-armed it later either. A context the tab or the machine puts to
     sleep after a long idle produces the same failure hours into a page that
     had been working, which is exactly what "sometimes it doesn't play" is.

   So: play only on a RUNNING context; if it is asleep, wake it and play when
   it is awake; and if it cannot be woken yet, HOLD the sound and play it on the
   first touch of the page. Measured on a suspended context: the beep is held
   (nothing played), and the first pointerdown plays it. A note is worth
   arriving a moment late. It is not worth losing.

   One thing that turned out NOT to be the mechanism, so nobody re-derives it:
   a suspended context's `currentTime` does not jump forward while it sleeps, so
   scheduling off the frozen clock is not scheduling into the past. Measured
   both ways through an analyser — same peak, 0.139. The bug was the context
   never running, not the time it was given. */
let AC = null;
let PENDING = null;                  // a sound that arrived while the context slept
function audio() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!C) return null;
  if (!AC) AC = new C();
  return AC;
}
function playNotes(ac, notes) {
  // A block of margin, not a fix: scheduling on the exact current time races
  // the audio thread's next render quantum for no gain.
  const now = ac.currentTime + 0.02;
  notes.forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(ac.destination);
    const t = now + i * 0.13;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.start(t); o.stop(t + 0.24);
  });
}
function beep(kind) {
  if (!SOUND) return;
  try {
    const ac = audio();
    if (!ac) return;
    const notes = kind === 'needs' ? [660, 880] : kind === 'failed' ? [400, 300] : [880, 1170];
    if (ac.state === 'running') { playNotes(ac, notes); return; }
    PENDING = notes;
    ac.resume().then(() => { const n = PENDING; PENDING = null; if (n && SOUND) playNotes(ac, n); }).catch(() => {});
  } catch {}
}
/* THE HANDSHAKE THAT MAKES SOUND POSSIBLE AT ALL. The browser hands out a
   context that may make noise only after the page has been touched, so the
   context is built and woken on the first pointer or key — before any agent
   needs it — and woken again whenever the tab comes back, which is where a
   sleeping context is otherwise discovered one lost beep too late. Anything
   that was held while it slept plays here. */
function armAudio() {
  try {
    const ac = audio();
    if (!ac || ac.state === 'running') { const n = PENDING; PENDING = null; if (ac && n && SOUND) playNotes(ac, n); return; }
    ac.resume().then(() => { const n = PENDING; PENDING = null; if (n && SOUND) playNotes(ac, n); }).catch(() => {});
  } catch {}
}
addEventListener('pointerdown', armAudio, { capture: true, passive: true });
addEventListener('keydown', armAudio, { capture: true, passive: true });
document.addEventListener('visibilitychange', () => { if (!document.hidden) armAudio(); });
function flashFrame(kind) {
  const f = $('#frame');
  f.className = 'frame ' + kind;
  clearTimeout(flashFrame._t);
  if (kind !== 'needs') flashFrame._t = setTimeout(() => (f.className = 'frame'), 2600);
}
/* The browser tab has to answer "where are my agents?" while you are looking at
   something else entirely — so both the title AND the favicon carry the state. */
function updateAmbient() {
  // inFleet, not inScope: the tab describes the live fleet even while you are
  // browsing the archive. This counted every agent before, including the
  // interactive terminal sessions the list hides — the same mismatch as the
  // header pills, one consumer further along.
  const vis = AGENTS.filter(inFleet);
  const needs = vis.filter((a) => lane(a) === 'needs').length;
  const working = vis.filter((a) => lane(a) === 'working').length;
  const unread = vis.filter((a) => a.unread).length;

  const f = $('#frame');
  if (needs) { if (!f.classList.contains('needs')) f.className = 'frame needs'; }
  else if (f.classList.contains('needs')) f.className = 'frame';

  // No separate "done" here: the pill says "12 done" (all of them) while the
  // tab meant "1 done" (only the unread ones) — two different meanings under
  // one word. The unread badge already is the finished-and-unseen signal.
  const bits = [];
  if (needs) bits.push(`${needs} need you`);
  if (working) bits.push(`${working} running`);
  const badge = unread ? `(${unread}) ` : '';
  // the workspace name has to survive here — boot set it once and this
  // overwrote it on the very next tick. It leads, because with one tab per
  // folder the tab strip is where you tell them apart.
  const ws = WSINFO ? `${wsLabel()} · ` : (WS === 'main' ? '' : `[${WS}] `);
  document.title = bits.length ? `${badge}${ws}${bits.join(' · ')} — flotilla` : `${ws}flotilla`;

  paintFavicon(needs ? '#fbbf24' : working ? '#4ade80' : unread ? '#7dd3fc' : '#3a3a44', unread);

  /* The floating window reads its numbers from HERE, never from AGENTS itself.
     A second place that counts is a second place that can be wrong, and this
     one is read from another monitor where you cannot cross-check it.
     `done` is deliberately not the pill's "done" (all of them) but the ones
     that finished while you were away and you have not looked at yet — which
     is what unread means on a terminal lane, and what you actually asked for. */
  paintPip({
    needs, working,
    done: vis.filter((a) => a.unread && (lane(a) === 'done' || lane(a) === 'failed')).length,
  });
}

/* ------------------------------------------------------- the second monitor */
/* A small always-on-top window you drag onto whichever screen you are working
   on. It is Document Picture-in-Picture: a real OS window that floats above
   Cursor, the terminal, everything — so it keeps answering "where is my fleet?"
   while the tab itself is buried or on a monitor you are not looking at.

   It is READ-ONLY on purpose. Clicking it brings this tab forward and does
   nothing else: no marking read, no steering. */
let PIP = null;
const pipOpen = () => Boolean(PIP && !PIP.win.closed);

const PIP_ROWS = [
  ['needs',   'need you'],
  ['working', 'running'],
  ['done',    'finished while away'],
];

async function openPip() {
  if (pipOpen()) { try { PIP.win.focus(); } catch {} return; }
  if (!('documentPictureInPicture' in window)) return;
  let win;
  try {
    win = await documentPictureInPicture.requestWindow({ width: 216, height: 126 });
  } catch { return; }   // no gesture, or the browser said no — nothing to repair

  // Same stylesheet as the app, so the mini window cannot drift into its own
  // little design. It is one cached file.
  win.document.head.appendChild(Object.assign(win.document.createElement('link'),
    { rel: 'stylesheet', href: '/style.css' }));
  win.document.title = 'flotilla';
  const card = el('div', 'pipcard');
  const rows = {};
  for (const [k, label] of PIP_ROWS) {
    const r = el('div', 'piprow ' + k);
    const n = el('b', 'pipnum', '0');
    r.appendChild(el('i', 'pipdot'));
    r.appendChild(n);
    r.appendChild(el('span', 'piplabel', label));
    card.appendChild(r);
    rows[k] = { root: r, num: n };
  }
  const foot = el('div', 'pipfoot', 'live');
  card.appendChild(foot);
  win.document.body.className = 'pipbody';
  win.document.body.appendChild(card);
  // Click = come to the tab. The window is a signal, not a control surface.
  win.document.body.addEventListener('click', () => { try { window.focus(); } catch {} });
  win.addEventListener('pagehide', () => { PIP = null; paintPipBtn(); });

  PIP = { win, rows, foot, last: '' };
  paintPipBtn();
  updateAmbient();          // never show an empty window for one payload's wait
}

function paintPip(counts) {
  if (!pipOpen()) return;
  /* Silence is ambiguous — the stream sends nothing when nothing changes. Only
     a missing heartbeat proves the numbers stopped being true, and stale
     numbers you cannot tell from live ones are worse than no window at all. */
  const live = Date.now() - LAST_STREAM_AT < 45000;
  const sig = `${counts.needs}/${counts.working}/${counts.done}/${live}`;
  if (sig === PIP.last) return;
  PIP.last = sig;
  for (const [k] of PIP_ROWS) {
    PIP.rows[k].num.textContent = String(counts[k]);
    PIP.rows[k].root.classList.toggle('zero', counts[k] === 0);
  }
  PIP.foot.textContent = live ? 'live' : 'not live — check the tab';
  PIP.win.document.body.classList.toggle('stale', !live);
}

function paintPipBtn() {
  const b = $('#btnPip');
  if (b) b.classList.toggle('on', pipOpen());
}

let faviconEl = null, lastFav = '';
function paintFavicon(color, count) {
  const sig = color + ':' + count;
  if (sig === lastFav) return;
  lastFav = sig;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = color; g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  if (count > 0) {
    g.fillStyle = '#08080a'; g.font = 'bold 42px -apple-system, system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(count > 9 ? '9+' : String(count), 32, 35);
  }
  if (!faviconEl) {
    faviconEl = document.querySelector('link[rel="icon"]') || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
  }
  faviconEl.href = c.toDataURL('image/png');
}
/* THE SOUND IS THE EDGE INTO UNREAD, not every lane edge.

   A lane edge is not the same thing as an event you want to hear. It also fires
   on the bookkeeping: `needs → done` the moment you answer, `done → working →
   done` when the daemon and a state file disagree for one poll, `idle → done`
   when a record finally catches up. That is exactly the "two or three sounds in
   a row while the agent is not even finished".

   The server already decides what deserves you, once, in trackLanes: it marks
   an agent UNREAD on the edge into an attention lane — and the mark STAYS until
   you read it. Following that flag instead means one sound per real event, and
   silence for as long as the same event is still sitting there unread.

   Three further gates, all against the same complaint:
   - only agents that are in the fleet ring; an archived row and a hidden
     interactive terminal are things you cannot even see;
   - a cooldown per agent AND KIND of event, so one that flaps after you have
     read it cannot ring twice inside it — while an agent that finishes and
     then asks you something 5 seconds later still gets to ask, because a
     question is not a repeat of a finish;
   - an agent seen for the FIRST time is never an event — that is a page load
     finding old work, not an agent finishing. */
const BEEP_COOLDOWN = 30000;
const BEEP_AT = new Map();           // key + lane -> when this agent last rang
function detectTransitions() {
  const next = new Map(), nextUnread = new Map();
  let loud = null;
  const now = Date.now();
  for (const a of AGENTS) {
    const k = keyOf(a), l = lane(a), unread = Boolean(a.unread);
    next.set(k, l); nextUnread.set(k, unread);
    /* Only the FIRST payload is exempt, and only because a page load finding
       old work is not the work happening. A key that turns up later is not the
       same thing: the page has been watching, so an agent it has never seen
       before, already unread and already in a lane that wants you, is an agent
       that appeared and finished between two looks. That used to be swallowed
       on the theory that an unknown key is a page load — which is true exactly
       once, and this is the once. (Keys that merely dropped out of a payload
       are carried over below, so a one-tick gap in the feed cannot turn a
       known agent back into a stranger.) */
    if (!BOOTED) continue;
    const rose = unread && !PREV_UNREAD.get(k);       // the edge into unread
    /* The one case that must ring THROUGH a standing unread mark: an agent you
       left unread finishes, gets picked up again and now asks you something.
       Being already marked is no reason to stay silent about a new question. */
    const asksNow = l === 'needs' && PREV.get(k) !== 'needs';
    if (!rose && !asksNow) continue;
    if (!ATTENTION_LANES.has(l) || !inFleet(a)) continue;
    const ring = k + '|' + l;
    /* THE COOLDOWN BELONGS TO THE TEST THAT CAN FLAP, AND ONLY TO IT.
       `asksNow` reads a lane edge, and lanes do flap: the daemon and a state
       file disagree for a poll and the same question arrives twice. `rose`
       cannot — it is the edge into the SERVER's unread mark, and that mark
       stands until you read it, so a second rise means you read the first one
       and the agent came back with something new. Sharing one 30-second gate
       made exactly that case silent: answer an agent, it finishes again inside
       half a minute, and nothing is heard. */
    if (!rose && now - (BEEP_AT.get(ring) || 0) < BEEP_COOLDOWN) continue;
    BEEP_AT.set(ring, now);
    if (l === 'needs') loud = 'needs';
    else if (l === 'failed' && loud !== 'needs') loud = 'failed';
    else if (l === 'done' && !loud) loud = 'done';
  }
  /* An agent missing from this payload keeps its last known answer instead of
     being forgotten. The feed drops rows (`gone`) on its own schedule, and a
     row that comes back after one tick away would otherwise arrive as a key
     nobody has ever seen — indistinguishable, now that a new key may ring,
     from an agent that just finished. */
  for (const [k, v] of PREV) if (!next.has(k)) next.set(k, v);
  for (const [k, v] of PREV_UNREAD) if (!nextUnread.has(k)) nextUnread.set(k, v);
  PREV = next;
  PREV_UNREAD = nextUnread;
  if (loud) { beep(loud); flashFrame(loud); }
  BOOTED = true;
}

/* --------------------------------------------------------------- markdown */
function md(src) {
  const fences = []; let s = String(src ?? '');
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fences.push(`<pre>${lang ? `<span class="lang">${esc(lang)}</span>` : ''}<code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
    return ` F${fences.length - 1} `;
  });
  s = esc(s);
  s = s.replace(/(^\|.+\|\s*$\n^\|[-: |]+\|\s*$\n(?:^\|.*\|\s*$\n?)*)/gm, (block) => {
    const lines = block.trim().split('\n');
    const cells = (l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(lines[0]), body = lines.slice(2).map(cells);
    return '<table><thead><tr>' + head.map((h) => `<th>${h}</th>`).join('') + '</tr></thead><tbody>'
      + body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  });
  s = s.replace(/^(result:)\s*(.*)$/gim, '<div class="verdict ok"><b>result</b>$2</div>')
       .replace(/^(needs input:)\s*(.*)$/gim, '<div class="verdict need"><b>needs input</b>$2</div>')
       .replace(/^(failed:)\s*(.*)$/gim, '<div class="verdict bad"><b>failed</b>$2</div>');
  s = s.replace(/^#{4,6} (.*)$/gm, '<h3>$1</h3>').replace(/^### (.*)$/gm, '<h3>$1</h3>')
       .replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>');
  s = s.replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, '<hr>');
  s = s.replace(/^&gt; ?(.*)$/gm, '<blockquote>$1</blockquote>').replace(/<\/blockquote>\n<blockquote>/g, '<br>');
  s = s.replace(/(?:^[ \t]*[-*+] .*(?:\n|$))+/gm, (b) => '<ul>' + b.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*[-*+] /, '')}</li>`).join('') + '</ul>');
  s = s.replace(/(?:^[ \t]*\d+\. .*(?:\n|$))+/gm, (b) => '<ol>' + b.trim().split('\n').map((l) => `<li>${l.replace(/^[ \t]*\d+\. /, '')}</li>`).join('') + '</ol>');
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>')
       .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
       .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  s = s.split(/\n{2,}/).map((p) => {
    const t = p.trim(); if (!t) return '';
    if (/^<(h[123]|ul|ol|pre|blockquote|table|hr|div)/.test(t)) return t;
    if (/^ F\d+ $/.test(t)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).join('\n');
  return s.replace(/ F(\d+) /g, (_, i) => fences[Number(i)]);
}

/* ------------------------------------------------------------------- list */
/* Order by when YOU last spoke to it, not by its last internal change. Sorting
   on "last change" makes the working list shuffle every few seconds as tool
   calls land — the list moves while you are reading it. Last input only moves
   when you do something, so the order holds still.

   One exception, and it is an EVENT, not a level: finishing, failing or asking
   for you. Those happen once, so they cannot make the list shuffle — and an
   agent that just came back with its result belongs at the top, above the ones
   you prompted after it, or you scroll past it every time. `laneAt` is the
   server's edge clock (when the lane was entered), and only the lanes that want
   you count; a working agent's laneAt is when it started, which is noise. */
const ATTENTION_LANES = new Set(['done', 'failed', 'needs']);
const promptTs = promptStart;        // the same clock, and the same cache
const attentionTs = (a) => (a.laneAt && ATTENTION_LANES.has(lane(a))) ? a.laneAt : 0;
const ts = (a) => Math.max(promptTs(a), attentionTs(a));
const SORTS = {
  recent:  (a, b) => ts(b) - ts(a),
  oldest:  (a, b) => ts(a) - ts(b),
  unread:  (a, b) => (b.unread ? 1 : 0) - (a.unread ? 1 : 0) || ts(b) - ts(a),
  name:    (a, b) => String(a.name || a.id || '').localeCompare(String(b.name || b.id || '')),
  created: (a, b) => (Date.parse(b.createdAt || 0) || b.startedAt || 0) - (Date.parse(a.createdAt || 0) || a.startedAt || 0),
  folder:  (a, b) => String(a.cwd || '').localeCompare(String(b.cwd || '')) || ts(b) - ts(a),
};

/* ONE definition of "an agent I am currently looking after". The header pills
   and the list both read it, because they disagreed before: the header counted
   interactive terminal sessions that the list hides by default, so it said
   "4 working" over a list showing 3. A count you cannot point at is worse than
   no count. */
const showsTerminals = () => $('#showInteractive').checked;

/** The live fleet — what the pills and the browser tab describe. */
function inFleet(a) {
  if (a.archived) return false;
  if (!inWorkspace(a)) return false;
  if (a.kind === 'interactive' && !showsTerminals()) return false;
  return true;
}
/** What the list shows right now — the archive is a separate room. */
function inScope(a) {
  if (Boolean(a.archived) !== ARCHIVE_VIEW) return false;
  if (!inWorkspace(a)) return false;
  if (a.kind === 'interactive' && !showsTerminals()) return false;
  return true;
}

/* WHAT A QUERY SEARCHES.

   The fields were never the problem: `intent` is the FIRST PROMPT, complete —
   measured over 40 agents, not one was truncated (median 1720, longest 9838
   characters, identical to the transcript). What broke finding things was that
   the search only ever saw what the list was already showing. Measured on the
   live fleet: 178 of 268 agents were hidden as done/stopped, 21 archived, 11
   interactive — leaving **58 of 268 (21%)** that any query could reach at all.
   Four out of five agents were unfindable no matter what you typed.

   So a query overrules the browsing filters. Hiding finished agents is for
   BROWSING; typing is asking to FIND, and those are different intentions. The
   archive stays its own room — but the list says how many matches are in there
   and takes you across. */
const hayOf = (() => {
  const memo = new WeakMap();
  return (a) => {
    let h = memo.get(a);
    if (h === undefined) {
      h = [a.name, a.detail, a.intent, a.cwd, a.id].filter(Boolean).join(' \n').toLowerCase();
      memo.set(a, h);
    }
    return h;
  };
})();
/* Every word must appear, in any order and anywhere. A single `includes` of the
   whole query meant "login bug" found the agent and "bug login" found nothing. */
const hits = (a, tokens) => { const h = hayOf(a); return tokens.every((t) => h.includes(t)); };
let QTOKENS = [];

/* A window around the first match, so the reason the row is here is on screen.
   Prompts run to thousands of characters; their first 190 almost never contain
   the word you typed. */
function snippetFor(a, tokens) {
  for (const field of [a.intent, a.detail, a.cwd]) {
    const src = String(field || '');
    if (!src) continue;
    const low = src.toLowerCase();
    const i = low.indexOf(tokens[0]);
    if (i < 0) continue;
    const from = Math.max(0, i - 55);
    return (from ? '… ' : '') + src.slice(from, from + 190).trim() + (from + 190 < src.length ? ' …' : '');
  }
  return null;
}
function highlight(text, tokens) {
  let out = esc(text);
  for (const t of tokens) {
    if (!t) continue;
    const re = new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

/* A ROW IS ONLY REBUILT WHEN WHAT IT SHOWS CHANGES.

   The list is rebuilt on every agents payload — every 1.5 seconds — and on
   every keystroke in the search box. Measured at this fleet's size: 236 rows,
   about 15 elements each, 74ms per pass, while typically 8 of those rows had
   actually moved. 74ms is four dropped frames, and it lands on the same thread
   that is supposed to be accepting your keystrokes.

   Re-appending an existing node MOVES it, which is cheap; it is the
   construction that costs. So the signature carries everything the row draws —
   miss one and the row goes stale, which is worse than slow. */
/* NOT in the signature: anything that changes on the CLOCK rather than on the
   agent. `ago(ts(a))` did, and below a minute it ticks every second — so every
   recently-touched row was rebuilt once a second, all day. Two things break
   when a row is rebuilt under the pointer: the replacement node does not get
   `:hover` until the mouse moves again (so its buttons vanish and come back
   "after a few seconds"), and a click whose mousedown and mouseup land on two
   different nodes is never delivered at all. The clock now writes into the node
   it owns — `data-ago`, the same mechanism the pane footer uses. */
let PANE_IDX = new Map();            // rebuilt once per pass, not once per row
/* THE HALF THAT IS THE AGENT IS CACHED ON THE AGENT.

   A payload replaces only the records that moved, so an unchanged agent is
   literally the same object as last pass and its half of the signature cannot
   have changed. Measured: of the 13ms a list pass costs, 7.7ms was rebuilding
   516 signatures of which a handful differed. The WeakMap dies with the record.

   The one thing that can go wrong is a record mutated IN PLACE — `override`
   does exactly that when you click archive or pin — so both places that write
   into a live record drop its entry (see `override`, `applyOverrides`). */
const SIG_SELF = new WeakMap();
const selfSig = (a, l) => {
  let sig = SIG_SELF.get(a);
  if (sig === undefined) {
    sig = [
      l, a.name, a.unread ? 1 : 0, a.detail, a.activity?.said, a.cwd, a.waitingFor,
      a.shells, a.archived ? 1 : 0, a.pinned ? 1 : 0, a.alive ? 1 : 0, a.id, colorOf(a), patternOf(a),
      // The ANCHOR, not the text it produces: `ts` moves when the agent gets a
      // prompt or finishes — twice an hour, not once a second — and the row has
      // to be rebuilt then, or its clock keeps counting from the old moment.
      ts(a), String(a.intent || '').length,
    ].join('\u0001');
    SIG_SELF.set(a, sig);
  }
  return sig;
};
/* …and the half that is the SCREEN is not: which pane it is open in, whether it
   holds the cursor, what you have typed into the search box. Those change for
   every row at once, and computing them is six lookups. */
const rowSig = (a, l) => {
  const k = keyOf(a);
  return selfSig(a, l) + '\u0001' + [
    PANE_IDX.get(k) ?? -1, FOCUSED === k ? 1 : 0, drafts.has(k) ? 1 : 0,
    QTOKENS.join(' '), ARCHIVE_VIEW ? 1 : 0, PREFS.archiveStops ? 1 : 0,
  ].join('\u0001');
};
/* What is on screen right now, in order. Holds only nodes that ARE in the
   document, so it cannot accumulate detached ones. */
let LIST_SEQ = [];
/* A row the pointer is inside, or that holds the keyboard focus, is a row you
   are AIMING AT. It is never swapped out from under you; its repaint waits for
   the pointer to leave. Nothing is lost — the deferred pass runs on mouseleave
   and again on the next payload. */
let LIST_DEFERRED = false;
/* WHICH ROW THE POINTER IS ON IS REMEMBERED, NOT ASKED. Asking — `matches(':hover')`
   — makes the browser bring style up to date first, and after a row has just
   been removed that means recalculating all 430 of them: measured 54ms per
   archive, on the click path, for a question a pointerover listener answers
   for free. */
let HOVER_ROW = null;
const rowHot = (node) => node === HOVER_ROW || node.contains(document.activeElement);
/* Repaint ONE row. An action on a row changes that row, not the other 235 —
   rebuilding the whole list to flip one mail icon is how ten archive clicks in
   a row turn into ten full passes. */
function patchRow(key) {
  const a = findAgent(key);
  // Not an agent at all (a compose pane holds a key no row can carry): there is
  // nothing to patch and nothing to rebuild.
  if (!a) return;
  const i = LIST_SEQ.findIndex((x) => x.id === 'r:' + key);
  if (i < 0) { scheduleList(); return; }
  const l = lane(a), sig = rowSig(a, l);
  if (sig === LIST_SEQ[i].sig) return;
  const node = agentRow(a, l);
  LIST_SEQ[i].node.replaceWith(node);
  LIST_SEQ[i].sig = sig; LIST_SEQ[i].node = node; LIST_SEQ[i].make = () => agentRow(a, l);
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  QTOKENS = q ? q.split(/\s+/).filter(Boolean) : [];
  const showDone = $('#showDone').checked;
  LIST_DEFERRED = false;
  PANE_IDX = new Map(paneKeys().map((k, i) => [k, i]));

  const rows = AGENTS.filter((a) => {
    // the archive is a separate room, in both directions
    if (Boolean(a.archived) !== ARCHIVE_VIEW) return false;
    // and so is every other folder — this window is about ONE
    if (!inWorkspace(a)) return false;
    if (QTOKENS.length) return hits(a, QTOKENS);
    /* A PIN BEATS THE TWO BULK SWITCHES. `done` and `terminals` mean "collapse
       the noise"; the pin means "not this one". A pinned chat that vanishes
       because you folded away finished agents is the exact thing the pin was
       put there to prevent. The search and the archive room still win — one is
       a question you asked, the other is a different room. */
    if (a.pinned) return true;
    if (a.kind === 'interactive' && !showsTerminals()) return false;
    const l = lane(a);
    // the done checkbox only collapses the list; the pill stays the reminder
    // that finished agents exist
    if (!ARCHIVE_VIEW && !showDone && (l === 'done' || l === 'stopped')) return false;
    return true;
  });
  const elsewhere = QTOKENS.length
    ? AGENTS.filter((a) => Boolean(a.archived) !== ARCHIVE_VIEW && inWorkspace(a) && hits(a, QTOKENS)).length : 0;
  // a search must not say "nothing" while the agent sits in another folder either
  const otherFolders = QTOKENS.length && !ALL_FOLDERS
    ? AGENTS.filter((a) => Boolean(a.archived) === ARCHIVE_VIEW && !inWorkspace(a) && hits(a, QTOKENS)).length : 0;

  /* THE PIN OUTRANKS THE SORT — that is the entire point of it. Pinned rows are
     lifted out here and drawn in their own group above everything, newest pin
     first, whatever the sort and the grouping do below. Three rules keep it
     from becoming a second, silent filter:

     · the pin only MOVES a row, it never hides one — switch the top group off
       (the `pins` checkbox) and the same rows sort in with the rest again;
     · the archive stays a separate room in both directions, so the top group
       exists on the dashboard only (archiving takes the pin off anyway);
     · a search still searches everything — a pinned row that does not match
       the query is gone from the list like any other. */
  const pinsTop = PREFS.pinsTop !== false && !ARCHIVE_VIEW;
  const pins = pinsTop ? rows.filter((a) => a.pinned).sort((x, y) => (y.pinnedAt || 0) - (x.pinnedAt || 0)) : [];
  const pinned = new Set(pins.map(keyOf));
  const rest = pins.length ? rows.filter((a) => !pinned.has(keyOf(a))) : rows;

  const within = SORTS[PREFS.sort] || SORTS.recent;
  const list = $('#list');
  /* Read here, where the layout is still clean and it is free — never after
     the DOM has been touched, where the same read makes the browser lay out
     every row before it can answer. It is only WRITTEN back when a row was
     actually taken out, which is the one case the browser cannot hold by
     itself: archiving something above the fold pulls the whole list up under
     your cursor, and the next click lands on the wrong agent. */
  const keep = list.scrollTop;

  const groupsOf = () => {
    if (PREFS.group === 'none') return [['', rest.slice().sort(within)]];
    if (PREFS.group === 'folder') {
      const m = new Map();
      for (const a of rest) { const k = short(a.cwd) || '—'; (m.get(k) || m.set(k, []).get(k)).push(a); }
      return [...m.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([k, v]) => [k, v.sort(within)]);
    }
    const m = new Map();
    for (const a of rest) { const k = lane(a); (m.get(k) || m.set(k, []).get(k)).push(a); }
    return [...m.entries()].sort((x, y) => LANE_ORDER[x[0]] - LANE_ORDER[y[0]]).map(([k, v]) => [k, v.sort(within)]);
  };

  /* Describe the list first, TOUCH it second. Emptying the sidebar and
     re-appending 236 rows costs a full layout every 1.5 seconds — measured
     114ms, four dropped frames, on the same thread that is meant to accept your
     keystrokes. Almost always the sequence is identical and a handful of
     signatures moved, so only those nodes get replaced and the browser has
     nothing to re-lay-out. */
  const seq = [];
  if (pins.length) {
    const unread = pins.filter((a) => a.unread).length;
    seq.push({
      id: 'g:__pins', sig: ['pins', pins.length, unread, pins.map(keyOf).join(',')].join('\u0001'),
      make: () => {
        const h = el('div', 'group pins');
        h.appendChild(el('span', 'gname', 'Pinned'));
        h.appendChild(el('span', 'gcount', String(pins.length)));
        if (unread) h.appendChild(el('span', 'gunread', `${unread} unread`));
        h.title = 'Pinned chats stay on top. The `pins` switch below sorts them back in.';
        return h;
      },
    });
    for (const a of pins) {
      const l = lane(a);
      seq.push({ id: 'r:' + keyOf(a), sig: rowSig(a, l), make: () => agentRow(a, l) });
    }
  }
  for (const [gk, items] of groupsOf()) {
    if (gk !== '') {
      const unread = items.filter((a) => a.unread).length;
      const collapsed = Boolean(PREFS.collapsed[gk]);
      seq.push({
        id: 'g:' + gk, sig: [gk, items.length, unread, collapsed ? 1 : 0, PREFS.group].join('\u0001'),
        make: () => {
          const h = el('div', 'group ' + (PREFS.group === 'state' ? gk : ''));
          h.appendChild(el('span', 'gname', PREFS.group === 'state' ? (LANE_LABEL[gk] || gk) : gk));
          h.appendChild(el('span', 'gcount', String(items.length)));
          if (unread) h.appendChild(el('span', 'gunread', `${unread} unread`));
          h.onclick = () => { PREFS.collapsed[gk] = !PREFS.collapsed[gk]; savePrefs(); renderList(); };
          if (collapsed) h.classList.add('collapsed');
          return h;
        },
      });
      if (collapsed) continue;
    }
    for (const a of items) {
      const l = lane(a);
      seq.push({ id: 'r:' + keyOf(a), sig: rowSig(a, l), make: () => agentRow(a, l) });
    }
  }
  if (!rows.length) {
    const none = !ARCHIVE_VIEW && !QTOKENS.length && !ALL_FOLDERS && ROOT && !AGENTS.some(inWorkspace);
    const txt = ARCHIVE_VIEW ? 'Nothing archived.'
      : none ? `No agents in ${short(ROOT)} yet. “+ New agent” starts one here.` : 'Nothing matches.';
    seq.push({ id: 'empty', sig: txt, make: () => el('div', 'nores', txt) });
  }
  /* The archive stays a separate room — but a search must never be able to say
     "nothing" while the thing sits one room over. */
  if (elsewhere) {
    const txt = `${elsewhere} more ${ARCHIVE_VIEW ? 'on the dashboard' : 'in the archive'} →`;
    seq.push({ id: 'more', sig: txt, make: () => {
      const more = el('div', 'searchmore', txt);
      more.onclick = () => { ARCHIVE_VIEW = !ARCHIVE_VIEW; renderList(); };
      return more;
    } });
  }
  if (otherFolders) {
    const txt = `${otherFolders} more in other folders →`;
    seq.push({ id: 'morefolders', sig: txt, make: () => {
      const more = el('div', 'searchmore', txt);
      more.title = 'Show agents from every folder in this window (switch it back in the workspace menu, top left)';
      more.onclick = () => setAllFolders(true);
      return more;
    } });
  }

  /* ONE path, keyed by id — there is no "the order changed, throw it all away"
     any more. With the default sort (newest activity) a working agent moves in
     the order on nearly every payload, so that branch was the NORMAL case: 236
     nodes destroyed and rebuilt every 1.5 seconds, taking the hover state, the
     scroll position and any click in flight with them. Reusing a node and
     moving it is a pointer swap; building one is fifteen elements. */
  const before = new Map(LIST_SEQ.map((x) => [x.id, x]));
  for (const x of seq) {
    const old = before.get(x.id);
    if (!old) { x.node = x.make(); continue; }
    before.delete(x.id);
    if (old.sig === x.sig) { x.node = old.node; continue; }
    if (rowHot(old.node)) { x.node = old.node; x.sig = old.sig; LIST_DEFERRED = true; continue; }
    x.node = x.make();
  }
  /* TAKE THE GONE ONES OUT FIRST, then walk the order. Both halves matter: a
     single archived row, swept out here, leaves every other node exactly where
     it already is and the walk below touches nothing. Without the sweep the
     walk meets the doomed node at position 3 and shoves all 427 rows behind it
     forward one place — measured 34ms per click, all of it moving nodes that
     were already in the right order. */
  const want = new Set(seq.map((x) => x.node));
  let removed = 0;
  for (const n of [...list.children]) if (!want.has(n)) { n.remove(); removed++; }
  let cur = list.firstChild;
  for (const x of seq) {
    if (cur === x.node) { cur = cur.nextSibling; continue; }
    list.insertBefore(x.node, cur);
  }
  if (removed && keep) list.scrollTop = keep;   // a write, never a read: see above
  LIST_SEQ = seq;

  const vis = AGENTS.filter(inFleet);   // pills = the fleet, list = the current room
  const n = (f) => vis.filter(f).length;
  const c = $('#counts'); c.textContent = '';
  const add = (t, cls, fn) => { const s = el('span', 'pill' + (cls ? ' ' + cls : '')); s.innerHTML = t; if (fn) { s.style.cursor = 'pointer'; s.onclick = fn; } c.appendChild(s); };
  const needs = n((x) => lane(x) === 'needs'), work = n((x) => lane(x) === 'working');
  const unread = n((x) => x.unread), alive = n((x) => x.alive && x.kind === 'background');
  if (needs) add(`<b>${needs}</b> need you`, 'hot');
  if (unread) add(`<b>${unread}</b> unread`, 'unreadpill');
  add(`<b>${work}</b> working`, work ? 'run' : '');
  add(`<b>${n((x) => lane(x) === 'done')}</b> done`);
  add(`<b>${alive}</b> live · ≈<b>${(alive * 0.46).toFixed(1)} GB</b>`);
  // a text filter narrows the list but not the fleet — say which is which
  if (q) add(`<b>${rows.length}</b> shown`, 'unreadpill');

  const arch = AGENTS.filter((a) => a.archived && inWorkspace(a)).length;
  const ab = $('#btnArchiveView');
  ab.textContent = ARCHIVE_VIEW ? `← Back (${arch})` : `Archive (${arch})`;
  ab.classList.toggle('on', ARCHIVE_VIEW);
  updateAmbient();
}

/* The whole row is the agent's colour — asked for explicitly, and it also makes
   two rows in the same lane distinguishable at a glance, which a shared state
   colour never can. The state rides on the dot and the lane grouping. */
function agentRow(a, l) {
  const k = keyOf(a);
  const open = !!locate(k);
  const row = el('div', `row-agent ${l} ${patClass(a)}` + (open ? ' open' : ''));
  row.style.setProperty('--c', colorOf(a));

  if (a.unread) row.classList.add('unread');
  if (a.pinned) row.classList.add('pinned');
  // "open" and "focused" get their own marks. They used to be expressed as more
  // of the same colour the row already carried for identity, which read as
  // "unread" — one channel cannot mean three things.
  const paneIdx = PANE_IDX.get(k) ?? -1;
  if (paneIdx >= 0) row.classList.add('isopen');
  if (k === FOCUSED) row.classList.add('isfocused');

  const top = el('div', 'rtop');
  top.appendChild(el('span', `dot ${l}` + (a.alive ? '' : ' hollow')));
  top.appendChild(el('div', 'r-name', a.name || a.id || a.sessionId?.slice(0, 8) || '—'));
  if (paneIdx >= 0) {
    const b = el('span', 'openbadge', String(paneIdx + 1));
    b.title = k === FOCUSED ? 'Open — and where your cursor is' : `Open in pane ${paneIdx + 1} — the ⌖ button jumps there`;
    top.appendChild(b);
  }

  const acts = el('div', 'r-acts');
  /* POINTERDOWN, not click. A `click` is only delivered if the press and the
     release land on the SAME node — and this list redraws itself while you are
     aiming at it, so the release used to arrive at a fresh button and the
     action was silently dropped. Pressing is the decision; nothing here is
     destructive enough to need a release to confirm it. */
  const ico = (glyph, title, fn) => {
    const b = el('button', 'r-ico', typeof glyph === 'string' ? glyph : null); b.title = title;
    if (typeof glyph !== 'string') b.appendChild(glyph);
    b.onpointerdown = (e) => { e.stopPropagation(); e.preventDefault(); fn(); };
    b.onclick = (e) => { e.stopPropagation(); e.preventDefault(); };
    acts.appendChild(b); return b;
  };
  if (!ARCHIVE_VIEW) {
    ico(locateIcon(), paneIdx >= 0
      ? `Show me pane ${paneIdx + 1} — scrolls there and flashes it`
      : 'Open it and scroll there',
      () => showPane(k));
    ico(mailIcon(a.unread), a.unread ? 'Mark read' : 'Mark unread',
      () => (a.unread ? markRead(k) : markUnread(k)));
    ico(pinIcon(a.pinned), a.pinned
      ? 'Unpin — it goes back to its place in the sort'
      : 'Pin to the top — it stays in sight while you work somewhere else',
      () => setPinned(k, !a.pinned));
    ico('⌫', PREFS.archiveStops && a.alive && TERMINAL.has(l)
      ? 'Archive — hides it and runs `claude stop` to free ~0.46 GB. The conversation is kept.'
      : 'Archive — hides it here. The conversation is kept.',
      () => setArchived(k, true));
  } else {
    ico('↩', 'Move back to the dashboard', () => setArchived(k, false));
  }
  top.appendChild(acts);
  /* No separate unread pip beside the buttons. The mail icon two pixels to its
     left already draws filled-vs-outline for exactly this, the whole row glows
     while unread, and the row is 330px wide — a third way of saying the same
     word was costing the name its last characters. */
  if (a.unread && ARCHIVE_VIEW) top.appendChild(el('span', 'unread-pip'));
  row.appendChild(top);

  if (l === 'working') {
    const act = el('div', 'r-act');
    act.appendChild(dotsEl());
    const t = el('span', 'acttext', activityText(a));
    t.dataset.live = k; t.title = TIMER_TITLE;
    act.appendChild(t);
    row.appendChild(act);
  }

  // last real output, so "still moving" is distinguishable from "wedged"
  const said = a.activity?.said;
  let d = said || a.detail || a.intent || '';
  /* When the hit is in the PROMPT rather than the name, show the piece of the
     prompt that matched instead of its first 190 characters. Otherwise the row
     that answers your search looks exactly like the twenty that do not. */
  let marked = null;
  if (QTOKENS.length) {
    const inName = QTOKENS.every((t) => String(a.name || '').toLowerCase().includes(t));
    if (!inName) {
      const snip = snippetFor(a, QTOKENS);
      if (snip) { d = snip; marked = true; }
    }
  }
  if (d) {
    const line = el('div', 'r-detail' + (said ? ' said' : '') + (marked ? ' hit' : ''));
    const text = d.replace(/\s+/g, ' ').slice(0, 190);
    if (marked) line.innerHTML = highlight(text, QTOKENS); else line.textContent = text;
    row.appendChild(line);
  }

  const meta = el('div', 'r-meta');
  if (a.waitingFor) meta.appendChild(el('span', 'badge-wait', a.waitingFor));
  if (l !== 'working' && shellNote(a)) {
    const sh = el('span', 'badge-shell', shellNote(a));
    sh.title = 'Its turn is over. Background shells are still running, which is why the daemon calls the process busy.';
    meta.appendChild(sh);
  }
  if (drafts.get(k)) meta.appendChild(el('span', 'badge-draft', 'draft'));
  meta.appendChild(el('span', 'tag', short(a.cwd).split('/').slice(-2).join('/') || '—'));
  // The time answers the same question the order does: how long since I gave it
  // this job — not how long since it last touched a file.
  const since = el('span', '', ago(ts(a)));
  // Written by the clock, not by a rebuild: this is the one thing on the row
  // that changes every second, and it used to redraw the whole row with it.
  if (ts(a)) since.dataset.ago = String(ts(a));
  since.title = attentionTs(a) > promptTs(a)
    ? ({ done: 'since it finished', failed: 'since it failed', needs: 'since it asked for you' })[lane(a)]
    : a.lastPromptAt ? 'since your last prompt' : 'since last change';
  meta.appendChild(since);
  row.appendChild(meta);

  /* THE CARD ITSELF IS NOT A BUTTON. It was one — the whole row opened the
     agent — and that is a 300×80px target sitting under three 24px ones you
     are trying to hit while the list reorders beneath your hand. Every miss
     opened a pane nobody asked for. Opening is what the ⌖ button is FOR, and
     it says so; the row is now only a place to read. */
  return row;
}

/* ------------------------------------------------------------- workspace */
/* The arrangement is a list of COLUMNS, each holding a vertical stack of panes
   — the same shape VS Code uses for editor groups. Left/right moves a pane
   between columns, up/down moves it inside one, and every divider is draggable.
   The whole thing is persisted per workspace (`WS`, see the top of the file),
   so a reload lands on the same desk. */
let LAYOUT = { cols: [] };
let layoutT = null;
/* NOTHING IS SAVED BEFORE THE DESK WAS LOADED. A page that could not read its
   layout starts with an empty one — and the first pane you opened used to post
   that empty desk over the real one, 494 panes gone for one click. */
let LAYOUT_READY = false;
const layoutBody = () => JSON.stringify({ name: WS, layout: LAYOUT, from: TAB_ID });
function saveLayout() {
  if (!LAYOUT_READY) return;
  clearTimeout(layoutT);
  layoutT = setTimeout(postLayout, 300);
}
async function postLayout() {
  layoutT = null;
  try {
    const r = await fetch('/api/workspace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: layoutBody() });
    if (!r.ok) throw new Error(String(r.status));
  } catch {
    // the server is restarting: the desk in memory is the newest one, keep trying
    clearTimeout(layoutT);
    layoutT = setTimeout(postLayout, 2000);
  }
}
/* Closing the tab inside the 300 ms debounce must not lose the last move. */
addEventListener('pagehide', () => {
  if (!layoutT || !LAYOUT_READY) return;
  clearTimeout(layoutT); layoutT = null;
  try { navigator.sendBeacon('/api/workspace', new Blob([layoutBody()], { type: 'application/json' })); } catch {}
});
/** The server rules on what a stored desk may contain. Used on load AND when
 *  another window of the same workspace changed it. Agent panes whose agent is
 *  gone are dropped — but only against a list that actually LOADED: an empty
 *  agent list is a failed request, not a fleet with nobody in it. */
function sanitizeLayout(saved) {
  const alive = new Set(AGENTS.map(keyOf));
  const known = (k) => !AGENTS.length || alive.has(k);
  return { cols: (saved?.cols || [])
    .map((c) => ({
      w: c.w || 1,
      // a half-written compose pane has no agent behind it yet and must
      // survive the reload anyway — that is the entire point of it
      panes: (c.panes || [])
        .filter((p) => isCompose(p.key) || known(p.key)
          || (isTerm(p.key) && known(agentOfTerm(p.key))))
        .map((p) => (isCompose(p.key) ? { key: p.key, h: p.h || 1, compose: p.compose } : { key: p.key, h: p.h || 1 })),
    }))
    .filter((c) => c.panes.length) };
}
/** Another window of this workspace saved its desk. Take it — unless this
 *  window has its own change on the way, which is newer and wins anyway. */
function adoptLayout(msg) {
  if (!LAYOUT_READY || msg?.name !== WS || msg.from === TAB_ID || layoutT) return;
  LAYOUT = sanitizeLayout(msg.layout);
  renderPanes();
}
const paneKeys = () => LAYOUT.cols.flatMap((c) => c.panes.map((p) => p.key));
function locate(key) {
  for (let ci = 0; ci < LAYOUT.cols.length; ci++) {
    const pi = LAYOUT.cols[ci].panes.findIndex((p) => p.key === key);
    if (pi >= 0) return { ci, pi };
  }
  return null;
}
function pruneCols() { LAYOUT.cols = LAYOUT.cols.filter((c) => c.panes.length); }


/* "Which of these eight windows is it?" — the row can point, but only the pane
   itself can prove it. Two scrollers are in play (the strip scrolls sideways, a
   column scrolls down); `scrollIntoView` walks both, which is why this is not
   done by hand. Then flash it, because eight panes look alike from two metres. */
function revealPane(key) {
  const st = PD.get(key);
  const root = st?.root;
  if (!root) return;
  root.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  root.classList.remove('found');
  void root.offsetWidth;          // restart the animation if it is still running
  root.classList.add('found');
  clearTimeout(st.foundT);
  st.foundT = setTimeout(() => root.classList.remove('found'), 1700);
}
/* The one thing the row click cannot do: it is a toggle, so on an open agent it
   CLOSES the pane. This always ends the same way — the pane on screen, lit. */
function showPane(key) {
  if (!locate(key)) { openPane(key); return; }   // openPane reveals it itself
  markRead(key);                                  // going to look at it is reading it
  setFocus(key);
  revealPane(key);
  /* A pane you asked for is fresh BEFORE it finishes scrolling into view. The
     observer would get there too, one frame later — this is the same work, just
     not a frame behind the gesture that asked for it. */
  catchUpPane(key);
}

function openPane(key) {
  markRead(key);
  if (locate(key)) { setFocus(key); revealPane(key); return; }
  // A new agent gets its own column: side by side is the default, never stacked
  // into rows behind your back.
  LAYOUT.cols.push({ w: 1, panes: [{ key, h: 1 }] });
  setFocus(key);
  /* The pane pass runs NOW, not on the next frame — it is the thing you asked
     for, and it now builds exactly one pane instead of rebuilding the strip.
     The list pass is the bookkeeping and waits for the frame. */
  renderPanes(); scheduleList(); saveLayout();
  catchUpPane(key);                 // the pane you asked for, drawn in this frame
  // A fresh pane is appended at the far right, which on a full strip is off
  // screen — opening something and seeing nothing happen is the same bug as not
  // being able to find it. rAF so the node has a layout box to scroll to.
  requestAnimationFrame(() => revealPane(key));
}
function closePane(key) {
  const at = locate(key);
  if (at) { LAYOUT.cols[at.ci].panes.splice(at.pi, 1); pruneCols(); }
  /* TAKE THE NODE OUT BY HAND, FIRST. Everything else here — the reconcile, the
     list, the save, throwing away an xterm — is bookkeeping that the browser
     must not have to finish before it can show you that the pane is gone.
     Measured before this line existed: 600ms of frozen UI per ✕. */
  const st = PD.get(key);
  try { st?.root?.remove(); } catch {}
  disposePane(key);
  /* The pane pass is the other half of the same answer — an emptied column has
     to go in this frame too, or the remaining panes resize twice. It is allowed
     to be synchronous because it no longer READS anything: nothing moved, so it
     is a handful of pointer comparisons and a style write. The list is the only
     thing here that is genuinely bookkeeping. */
  renderPanes(); scheduleList(); saveLayout();
}
function disposePane(key) {
  if (FOCUSED === key) FOCUSED = null;
  // The observer holds its targets, so a pane that is gone has to be dropped
  // here or the node — and the whole transcript under it — is never collected.
  const root = PD.get(key)?.root;
  if (root) paneWatch.unobserve(root);
  if (isTerm(key)) {
    // closing the terminal's pane closes the terminal — but never the session
    PD.delete(key);
    const ak = agentOfTerm(key);
    if (PD.get(ak)) closeTerm(ak);
    return;
  }
  const p = PD.get(key);
  // The map entry goes NOW, because paneKeys/PD have to agree with the layout
  // from this line on. Tearing down an xterm with 4000 lines of scrollback is
  // the slow half and nobody is waiting for it — it happens after the frame.
  PD.delete(key);
  if (p) setTimeout(() => { try { p.ws?.close(); } catch {} try { p.term?.dispose(); } catch {} }, 0);
}

function movePane(key, dir) {
  const at = locate(key); if (!at) return;
  const col = LAYOUT.cols[at.ci];
  const [item] = col.panes.splice(at.pi, 1);
  if (dir === 'up' || dir === 'down') {
    const to = Math.max(0, Math.min(col.panes.length, at.pi + (dir === 'down' ? 1 : -1)));
    col.panes.splice(to, 0, item);
  } else {
    const step = dir === 'right' ? 1 : -1;
    let ci = at.ci + step;
    if (ci < 0) { LAYOUT.cols.unshift({ w: col.w, panes: [] }); ci = 0; }
    else if (ci >= LAYOUT.cols.length) { LAYOUT.cols.push({ w: col.w, panes: [] }); ci = LAYOUT.cols.length - 1; }
    LAYOUT.cols[ci].panes.push(item);
  }
  pruneCols();
  renderPanes(); saveLayout();
}

/* A compose pane is a pane like any other: it lives in the layout, so it keeps
   its place across a reload, and you can leave it half-written while you work
   on other agents. It only becomes a real agent when you press Start. */
const isCompose = (k) => typeof k === 'string' && k.startsWith('new:');

/* A TERMINAL IS A PANE. It used to live in a strip at the bottom of its agent's
   pane — the one spot in the layout you cannot give more room to. As a pane it
   sits beside the conversation, drags wider, moves between columns, and can be
   stacked back under its agent, which is what the old bottom strip was minus
   the ability to resize it.

   The xterm and its socket stay on the AGENT's state: Reply, Insert and the
   arm/send flow all reach for `st.ws` / `st.term` there, and none of them
   should care where the thing is drawn. Only the DOM node moves. */
const isTerm = (k) => typeof k === 'string' && k.startsWith('term:');
const agentOfTerm = (k) => (isTerm(k) ? k.slice(5) : null);
const termKey = (k) => 'term:' + k;
function termHostOf(key) {
  const st = PD.get(key); if (!st) return null;
  return PD.get(termKey(key))?.host || st.termHost;
}
/* One place decides where the terminal is drawn and what the empty states say,
   so "undock", "dock", a re-render and a fresh attach cannot disagree. */
function mountTerm(agentKey) {
  const st = PD.get(agentKey); if (!st) return;
  const out = PD.get(termKey(agentKey));
  const host = out?.host || st.termHost;
  st.termWrap.hidden = Boolean(out) || !st.term;
  const node = st.term?.element;
  const reparented = Boolean(node && node.parentElement !== host);
  if (reparented) host.appendChild(node);
  if (out) { out.empty.hidden = Boolean(st.term); out.paint?.(); }
  /* A fit() MEASURES the terminal against its box, which is a forced layout —
     and a terminal that is still in the same box cannot get a different answer.
     The box itself says when it changed (see termWatch), so the only fit left
     here is the one after a move. */
  if (reparented) fitTerm(agentKey);
}
/* One place asks the xterm to re-measure, and it refuses on a box with no size
   — a hidden strip is 0 x 0, and a fit against that proposes nonsense. */
function fitTerm(agentKey) {
  const st = PD.get(agentKey); if (!st?.term) return;
  const host = st.term.element?.parentElement;
  if (!host || !host.clientWidth || !host.clientHeight) return;
  try { st.fit?.fit(); } catch {}
}
function undockTerm(agentKey) {
  const tk = termKey(agentKey);
  if (locate(tk)) { showPane(tk); return; }
  const at = locate(agentKey);
  // its own column, immediately right of the conversation it belongs to
  LAYOUT.cols.splice(at ? at.ci + 1 : LAYOUT.cols.length, 0, { w: 1, panes: [{ key: tk, h: 1 }] });
  renderPanes(); saveLayout();
  mountTerm(agentKey);
  requestAnimationFrame(() => revealPane(tk));
}
function dockTerm(agentKey) {
  const tk = termKey(agentKey), at = locate(tk);
  if (!at) return;
  // NOT closePane: that disposes the pane, and disposing a terminal pane kills
  // the terminal. Docking must keep the session and only move the box.
  LAYOUT.cols[at.ci].panes.splice(at.pi, 1); pruneCols();
  PD.delete(tk);
  renderPanes(); saveLayout();
  mountTerm(agentKey);
}

function buildTermPane(key) {
  const agentKey = agentOfTerm(key);
  const root = el('div', 'pane-col term'); root.dataset.key = key;
  const head = el('div', 'pane-head');
  const line1 = el('div', 'ph-line');
  line1.appendChild(el('span', 'state-chip termchip', 'Terminal'));
  const title = el('div', 'ph-title', '');
  line1.appendChild(title);
  const dock = el('button', 'ph-ico', '⇲');
  dock.title = 'Put it back under the conversation';
  dock.onclick = () => dockTerm(agentKey);
  line1.appendChild(dock);
  const close = el('button', 'ph-close', '✕');
  close.title = 'Close the terminal. Detaching never stops the session.';
  close.onclick = () => closePane(key);
  line1.appendChild(close);
  head.appendChild(line1);
  const line2 = el('div', 'ph-line2');
  const sub = el('span', 'ph-sub', '');
  line2.appendChild(sub);
  head.appendChild(line2);

  const host = el('div', 'termhost');
  host.dataset.termkey = agentKey;
  termWatch.observe(host);
  const empty = el('div', 'term-empty');
  const attach = el('button', 'btn primary small', 'Attach');
  attach.onclick = () => openTerm(agentKey);
  empty.append(el('div', 'term-emptytext', 'Not attached.'), attach);
  root.append(head, host, empty);

  const paint = () => {
    const a = findAgent(agentKey);
    title.textContent = a?.name || a?.id || agentKey;
    sub.textContent = a?.id ? `claude attach ${a.id}` : 'session gone';
    root.style.setProperty('--c', a ? colorOf(a) : '#7a8494');
    if (a) root.classList.add(patClass(a));
  };
  paint();
  PD.set(key, { root, host, empty, paint });
  return root;
}

function newComposePane() {
  const key = 'new:' + Math.random().toString(36).slice(2, 10);
  LAYOUT.cols.push({ w: 1, panes: [{ key, h: 1, compose: { cwd: defaultCwd(), name: '', model: '', effort: '', runtime: lastRuntime() } }] });
  /* THE BOX IS FOCUSED IN THE SAME TICK IT IS BUILT. This used to wait 60ms for
     a timer, on the far side of a pane pass that rebuilt the whole strip — so
     "new agent, start typing" meant a pane that appeared late and then swallowed
     the first characters because the caret was not in it yet. Nothing about
     starting the agent happens here: a compose pane is a text box and a form,
     and no terminal is opened until you press Start. */
  renderPanes();
  PD.get(key)?.draft?.focus();
  setFocus(key);
  saveLayout();
  requestAnimationFrame(() => revealPane(key));
}

/* AN AGENT THAT IS WAITING ON YOU IS ONE YOU OPENED IN ORDER TO ANSWER.

   `claude attach` costs a measured 4.3–8.7s before its prompt is drawn, and it
   costs that whether it starts when you touch the pane or three seconds later
   when you press Reply. So it starts here. Only on `needs`, only on a live
   agent, only once per pane, and it never steals the focus — every other lane
   keeps the old rule, which is the first keystroke in the draft box. Attaching
   sends nothing and changes nothing; it is the same client the Reply button
   opens. */
function maybePrewarm(key) {
  const st = PD.get(key), a = findAgent(key);
  if (!st || st.prewarmed || !a?.alive || !a.id) return;
  if (lane(a) !== 'needs') return;
  st.prewarmed = true;
  ensureTerm(key, { focus: false }).catch(() => {});
}
function composeCfg(key) {
  const at = locate(key); if (!at) return null;
  const p = LAYOUT.cols[at.ci].panes[at.pi];
  p.compose ||= { cwd: defaultCwd(), name: '', model: '', effort: '', runtime: lastRuntime() };
  /* Layouts saved before runtimes existed have no field. Defaulting on READ
     rather than migrating the file keeps one rule for both cases. */
  p.compose.runtime ||= lastRuntime();
  return p.compose;
}

/* RECONCILE, NEVER REBUILD.

   This used to detach every pane, empty `#panes` and append the whole strip
   back in layout order. Moving existing nodes was already the point — that is
   what keeps live terminals and half-typed drafts alive across a rearrange —
   but detaching them all to do it made the browser lay out every transcript in
   every pane from scratch. Measured with six panes open: 420ms, on the click
   path, which is exactly the frozen ✕.

   So the strip is walked the way the sidebar is: take out what is gone, then
   move only the nodes that are in the wrong place. A node that keeps its parent
   keeps its scroll offset, its selection and its focus for free — there is
   nothing to save and nothing to restore. Only a pane that genuinely changes
   column is detached, and only those few pay for it. */
function reconcile(parent, want) {
  const keep = new Set(want);
  for (const n of [...parent.children]) if (!keep.has(n)) n.remove();
  let cur = parent.firstChild;
  for (const n of want) {
    if (cur === n) { cur = cur.nextSibling; continue; }
    parent.insertBefore(n, cur);
  }
}
/* The column boxes and the drag handles are reused by POSITION. A handle's
   listeners close over its own `ci`/`pi` and read LAYOUT at drag time, so the
   index has to be part of the identity — which is exactly what the cache key
   is. Rebuilding them every pass was rebuilding the one thing whose identity
   never changes. */
/* THE COLUMN BOX BELONGS TO THE COLUMN, NOT TO ITS INDEX. Keyed by index this
   was a bug with a measurement: close the pane in column 2 and every column
   behind it shifts down one, so every pane in them found itself "in the wrong
   box", was detached, had its scroll offset read back (a forced layout each)
   and was re-attached — the exact full-strip rebuild this rewrite exists to
   avoid, triggered by the exact click it exists to make instant. The column
   OBJECT survives the splice; the element follows it. */
const COL_EL = new WeakMap();
function colFor(col) {
  let n = COL_EL.get(col);
  if (!n) COL_EL.set(col, n = el('div', 'col'));
  return n;
}
const SPLIT_EL = new Map();
function splitFor(axis, ci, pi) {
  const k = axis + ':' + ci + (pi === undefined ? '' : ':' + pi);
  let n = SPLIT_EL.get(k);
  if (!n) { n = makeSplit(axis, ci, pi); SPLIT_EL.set(k, n); }
  return n;
}
let COL_SPACER = null;

/* NOT EVERY OPEN PANE IS A PANE YOU CAN SEE. This dashboard gets used with the
   strip scrolled far to one side: measured on the real workspace, 265 panes
   open and about six of them on the screen. Every one of the other 259 was
   still asking the server for its transcript every two seconds (115 requests
   per tick) and still being repainted on every agents payload — work whose
   result nobody could look at, on the thread that owes you your next click.

   The observer says which panes the screen actually shows, with a screen's
   worth of margin on either side so scrolling never arrives at an empty one.
   Nothing is thrown away while a pane is away: it keeps its DOM, its scroll
   position, its draft and its terminal. It only stops being ASKED. The moment
   it comes back into view it catches up in one go — the tail is a byte-offset
   delta, so "everything I missed" costs exactly one request. */
function paneSeen(key) {
  const st = PD.get(key);
  return !st || st.onScreen !== false;        // unknown means yes: never skip on a guess
}
function catchUpPane(key) {
  if (isCompose(key) || isTerm(key)) return;
  updatePane(key);                            // head, lane, foot — cheap and synchronous
  tailPane(key);                              // and whatever the transcript did meanwhile
}
const paneWatch = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const key = e.target.dataset.key;
    const st = PD.get(key);
    if (!st) continue;
    const was = st.onScreen;
    st.onScreen = e.isIntersecting;
    /* `was !== true` and not `was === false`, because the FIRST callback after
       observe() arrives with no previous answer — and that first callback is
       what fills the panes you can see when a workspace is opened. */
    if (st.onScreen && was !== true) catchUpPane(key);
  }
}, { rootMargin: '400px 800px' });

function renderPanes() {
  const wrap = $('#panes');
  const keys = paneKeys();
  $('#empty').hidden = keys.length > 0;
  wrap.hidden = keys.length === 0;

  // Build only what does not exist yet — and only those get the first paint of
  // their chrome. The others are already right and are repainted by the feed.
  const fresh = [];
  for (const k of keys) {
    if (PD.get(k)) continue;
    if (isCompose(k)) buildComposePane(k);
    else if (isTerm(k)) buildTermPane(k);
    else buildPane(k);
    paneWatch.observe(PD.get(k).root);
    fresh.push(k);
  }

  /* WHO ACTUALLY MOVES, decided before a single node is touched — once the
     first column has been reconciled a travelling pane is already parentless
     and can no longer say where it came from. Carry the INTENT, not the number:
     a pane that was following the live end must still be following it
     afterwards, even though the transcript grew while it was out. */
  const moved = [];
  for (const col of LAYOUT.cols) {
    const colEl = colFor(col);
    for (const p of col.panes) {
      const st = PD.get(p.key);
      if (!st?.root.parentElement || st.root.parentElement === colEl) continue;
      moved.push([p.key, st.body ? { top: st.body.scrollTop, end: atBottom(st.body) } : null]);
    }
  }

  const top = [];
  LAYOUT.cols.forEach((col, ci) => {
    if (ci > 0) top.push(splitFor('h', ci));
    const colEl = colFor(col);
    applyColWidth(colEl, col);
    const inner = [];
    col.panes.forEach((p, pi) => {
      const st = PD.get(p.key);
      if (!st) return;
      if (pi > 0) inner.push(splitFor('v', ci, pi));
      st.root.style.flexGrow = String(p.h || 1);
      inner.push(st.root);
    });
    reconcile(colEl, inner);
    top.push(colEl);
  });
  /* A handle on the RIGHT EDGE of the last column, and a spacer for it to grow
     into. Without these the rightmost pane had no edge to pull, so the one
     direction you actually want more room in was the one direction that had no
     grip at all. */
  if (LAYOUT.cols.length) {
    top.push(splitFor('h', LAYOUT.cols.length));
    top.push(COL_SPACER ||= el('div', 'colspacer'));
  }
  reconcile(wrap, top);

  for (const [k, v] of moved) {
    const st = PD.get(k);
    if (st?.body && v) st.body.scrollTop = v.end ? st.body.scrollHeight : v.top;
  }
  /* Only the ones already known to be on the screen. Opening a workspace with
     265 panes used to fetch 115 transcripts in one burst — measured 8 seconds
     of a page that could not be used. The observer's first callback paints the
     handful you can actually see; the rest wait until you scroll to them. */
  for (const k of fresh) if (!isCompose(k) && !isTerm(k) && PD.get(k)?.onScreen === true) updatePane(k);
  // Re-parented, so the xterm needs its size taken again. A pane that stayed
  // put cannot have a different answer — and asking is a forced layout.
  for (const k of fresh) if (isTerm(k)) mountTerm(agentOfTerm(k));
  for (const [k] of moved) if (isTerm(k)) mountTerm(agentOfTerm(k));
}

function buildComposePane(key) {
  const cfg = composeCfg(key) || {};
  const root = el('div', 'pane-col compose'); root.dataset.key = key;

  const head = el('div', 'pane-head');
  const line1 = el('div', 'ph-line');
  line1.appendChild(el('span', 'state-chip draftchip', 'Draft'));
  line1.appendChild(el('div', 'ph-title', 'New agent'));
  const close = el('button', 'ph-close', '✕'); close.title = 'Discard';
  close.onclick = () => { setDraft(key, ''); closePane(key); };
  line1.appendChild(close);
  head.appendChild(line1);

  const form = el('div', 'compose-form');
  const field = (label, node) => { const l = el('label', 'cf'); l.appendChild(el('span', null, label)); l.appendChild(node); form.appendChild(l); return node; };
  const save = () => saveLayout();

  /* This workspace's folder first, then the folders inside it agents have used,
     then everything else under its own heading. The folder a pane already had
     is always an option — a select cannot show a value it does not list, and
     showing the wrong folder next to Start is worse than a long list. */
  const cwd = el('select');
  const opt = (c) => Object.assign(el('option'), { value: c, textContent: short(c) });
  const known = [...new Set([ROOT, cfg.cwd, ...(META.cwds || [])].filter(Boolean))];
  const here = known.filter((c) => underRoot(c, ROOT)).sort((x, y) => (x === ROOT ? -1 : y === ROOT ? 1 : x.localeCompare(y)));
  const other = known.filter((c) => !here.includes(c)).sort();
  for (const c of here) cwd.appendChild(opt(c));
  if (other.length) {
    const g = Object.assign(el('optgroup'), { label: 'Other folders' });
    for (const c of other) g.appendChild(opt(c));
    cwd.appendChild(g);
  }
  cwd.value = cfg.cwd || defaultCwd();
  cwd.onchange = () => { cfg.cwd = cwd.value; save(); };
  field('Folder', cwd);

  const name = el('input'); name.placeholder = 'optional'; name.value = cfg.name || '';
  name.oninput = () => { cfg.name = name.value; save(); };
  field('Name', name);

  const mk = (opts, val, set) => {
    const s = el('select');
    for (const [v, t] of opts) s.appendChild(Object.assign(el('option'), { value: v, textContent: t }));
    s.value = val || ''; s.onchange = () => { set(s.value); save(); };
    return s;
  };
  /* Runtime before Model, because it decides which models exist. A runtime
     without a key stays visible but unselectable — hiding it would make a
     missing key look like a missing feature. */
  const rtSel = el('select');
  for (const r of RUNTIMES()) {
    /* Spend rides on the label: the moment you pick a paid runtime is the
       moment to see how much of its budget is left. */
    const spend = r.budget ? ` · $${r.budget.spentUsd.toFixed(2)} / $${r.budget.limitUsd.toFixed(0)}` : '';
    const blocked = r.budget?.exhausted ? ' — budget exhausted' : ' — no key';
    const o = Object.assign(el('option'), { value: r.id, textContent: (r.ready ? r.label : r.label + blocked) + spend });
    o.disabled = !r.ready;
    // The reason belongs on the disabled option. Hung on the field it would be
    // invisible exactly when you need it: while pointing at what does not work.
    if (!r.ready && r.reason) o.title = r.reason;
    rtSel.appendChild(o);
  }
  if (!runtimeById(cfg.runtime)?.ready) cfg.runtime = (RUNTIMES().find((r) => r.ready) || RUNTIMES()[0]).id;
  rtSel.value = cfg.runtime;
  field('Runtime', rtSel);

  const modelSel = el('select');
  const fillModels = () => {
    const r = runtimeById(cfg.runtime);
    modelSel.textContent = '';
    modelSel.appendChild(Object.assign(el('option'), { value: '', textContent: 'default' }));
    for (const m of (r?.models || [])) modelSel.appendChild(Object.assign(el('option'), { value: m, textContent: m }));
    // A model from the other runtime is not a model here. Clearing it beats
    // sending a name the provider will not recognise.
    if (cfg.model && !(r?.models || []).includes(cfg.model)) cfg.model = '';
    modelSel.value = cfg.model || '';
    rtSel.title = r?.ready ? '' : (r?.reason || '');
  };
  rtSel.onchange = () => { cfg.runtime = rtSel.value; rememberRuntime(rtSel.value); fillModels(); save(); };
  modelSel.onchange = () => { cfg.model = modelSel.value; save(); };
  fillModels();
  field('Model', modelSel);
  field('Effort', mk([['', `default (${META.defaultEffort || 'medium'})`], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']], cfg.effort, (v) => (cfg.effort = v)));
  field('Permission', mk([['', 'default'], ['acceptEdits', 'acceptEdits'], ['plan', 'plan'], ['bypassPermissions', 'bypassPermissions']], cfg.permissionMode, (v) => (cfg.permissionMode = v)));

  const body = el('div', 'pane-body compose-body');
  body.appendChild(form);

  const draftWrap = el('div', 'pane-draft compose-draft');
  const draft = el('textarea');
  draft.placeholder = 'What should it do? Nothing is started until you press Start.';
  const bar = el('div', 'draftbar');
  const clip = el('button', 'btn ghost small', '📎');
  clip.title = 'Attach a file';
  const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  const hint = el('span', 'hint');
  const start = el('button', 'btn primary small', 'Start ⌘↵');
  bar.append(clip, picker, hint, el('div', 'spacer'), start);
  draftWrap.append(draft, bar);
  root.append(head, body, draftWrap);

  tightWatch.observe(root);
  const st = { root, head, body, draft, hint, startBtn: start, compose: true };
  PD.set(key, st);
  const focusHere = () => setFocus(key);
  root.addEventListener('pointerdown', focusHere, true);
  root.addEventListener('focusin', focusHere);

  draft.value = drafts.get(key)?.text ?? '';
  const grow = () => { draft.style.height = 'auto'; draft.style.height = Math.min(420, Math.max(120, draft.scrollHeight)) + 'px'; };
  draft.addEventListener('input', () => { setDraft(key, draft.value); grow(); });
  draft.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); startAgent(key); } });
  clip.onclick = () => picker.click();
  picker.onchange = () => { attachFiles(key, [...picker.files]); picker.value = ''; };
  draft.addEventListener('dragover', (e) => { e.preventDefault(); draftWrap.classList.add('dropping'); });
  draft.addEventListener('dragleave', () => draftWrap.classList.remove('dropping'));
  draft.addEventListener('drop', (e) => {
    draftWrap.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); attachFiles(key, files); }
  });
  draft.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); attachFiles(key, files); }
  });
  start.onclick = () => startAgent(key);
  requestAnimationFrame(grow);
  return root;
}

/* Start dispatches and then turns THIS pane into the agent's pane, in place —
   the window you were preparing in is the window it opens in. */
async function startAgent(key) {
  const st = PD.get(key), cfg = composeCfg(key);
  if (!st || !cfg) return;
  const prompt = st.draft.value.trim();
  if (!prompt) { st.hint.textContent = 'Write something first.'; return; }
  if (!cfg.cwd) { st.hint.textContent = 'Pick a folder.'; return; }

  st.startBtn.disabled = true;
  st.hint.textContent = 'Starting…';
  const before = new Set(AGENTS.filter((a) => a.kind === 'background').map(keyOf));

  const r = await (await fetch('/api/dispatch', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, cwd: cfg.cwd, name: cfg.name || undefined, model: cfg.model || undefined, effort: cfg.effort || undefined, permissionMode: cfg.permissionMode || undefined, runtime: cfg.runtime || undefined }),
  })).json();
  logCmd(r);
  if (!r.ok) { st.hint.textContent = 'Failed — see the command log.'; st.startBtn.disabled = false; return; }
  /* The server reports WHAT it used, not what was asked for. If the two
     differ, this is the only moment anyone still sees it. */
  if (r.runtime && r.runtime !== cfg.runtime) {
    st.hint.textContent = `WARNING: requested ${runtimeById(cfg.runtime).label}, started ${runtimeById(r.runtime).label}`;
  } else {
    st.hint.textContent = `Started on ${runtimeById(r.runtime || cfg.runtime).label}`;
  }

  // Which agent is the new one? Diffing the roster is steadier than parsing
  // whatever the CLI printed.
  for (let i = 0; i < 40; i++) {
    await new Promise((res) => setTimeout(res, 500));
    let agents; try { agents = (await (await fetch('/api/agents')).json()).agents; } catch { continue; }
    applyAgents(agents);
    const fresh = agents.filter((a) => a.kind === 'background' && !before.has(keyOf(a)));
    if (fresh.length) {
      const at = locate(key);
      setDraft(key, '');
      if (at) {
        const pane = LAYOUT.cols[at.ci].panes[at.pi];
        pane.key = keyOf(fresh[0]); delete pane.compose;
      }
      disposePane(key);
      renderPanes(); renderList(); saveLayout();
      return;
    }
  }
  st.hint.textContent = 'Started, but it has not shown up yet — check the list.';
  st.startBtn.disabled = false;
}

/* A column is either AUTO — it takes an equal share of whatever is on screen,
   which is what a freshly opened pane should do — or it is EXPLICIT, because you
   dragged its edge, and then it keeps exactly those pixels and the strip scrolls
   if that no longer fits.

   It used to be ratios only (`flex: 1 1 0` + grow), which meant the columns
   always summed to exactly one screen: dragging could only take width from a
   neighbour, never create any. Old layouts stored pixel numbers as those ratios,
   so they carry over as explicit widths unchanged. */
const colIsAuto = (col) => !(Number(col?.w) > 60);
function applyColWidth(elx, col) {
  if (colIsAuto(col)) { elx.style.flex = '1 1 0'; elx.style.width = ''; }
  else { elx.style.flex = '0 0 auto'; elx.style.width = Math.round(col.w) + 'px'; }
}

/* Dividers. Sizes are stored as the pixel widths measured at drop time. */
function makeSplit(axis, ci, pi) {
  const s = el('div', axis === 'h' ? 'split-h' : 'split-v');
  s.onpointerdown = (e) => {
    e.preventDefault();
    // Listeners go on the DOCUMENT, not on the divider. Pointer capture was the
    // first attempt and the drag silently did nothing: pointerdown arrived, and
    // everything after it was skipped. A 1px element is also the worst possible
    // thing to rely on for receiving moves. The document always gets them.
    try { s.setPointerCapture(e.pointerId); } catch {}
    const aEl = s.previousElementSibling, bEl = s.nextElementSibling;
    if (!aEl || !bEl) return;
    const horiz = axis === 'h';
    const start = horiz ? e.clientX : e.clientY;
    const aPx = horiz ? aEl.offsetWidth : aEl.offsetHeight;
    const bPx = horiz ? bEl.offsetWidth : bEl.offsetHeight;
    const MIN = horiz ? 320 : 140;
    /* Sideways this resizes the column to the LEFT and nothing else. The one to
       the right is pinned to the width it already had, so it cannot silently
       swallow what you just gained — that pinning is the whole difference
       between "make this wider" and "take it from the neighbour". */
    const bCol = horiz ? LAYOUT.cols[ci] : null;      // absent on the trailing handle
    if (horiz) {
      LAYOUT.cols[ci - 1].w = aPx; applyColWidth(aEl, LAYOUT.cols[ci - 1]);
      if (bCol) { bCol.w = bPx; applyColWidth(bEl, bCol); }
    }
    const onMove = (ev) => {
      const d = (horiz ? ev.clientX : ev.clientY) - start;
      if (horiz) {
        const a = Math.max(MIN, aPx + d);
        LAYOUT.cols[ci - 1].w = a;
        applyColWidth(aEl, LAYOUT.cols[ci - 1]);
        return;
      }
      const a = Math.max(MIN, aPx + d), b = Math.max(MIN, bPx - d);
      if (a + b > aPx + bPx + 1) return;              // both hit their floor
      aEl.style.flexGrow = String(a); bEl.style.flexGrow = String(b);
      LAYOUT.cols[ci].panes[pi - 1].h = a; LAYOUT.cols[ci].panes[pi].h = b;
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('dragging');
      saveLayout();
      for (const k of paneKeys()) { try { PD.get(k)?.fit?.fit(); } catch {} }
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.body.classList.add('dragging');
  };
  return s;
}

function buildPane(key) {
  const root = el('div', 'pane-col'); root.dataset.key = key;
  const head = el('div', 'pane-head');
  const tabs = el('div', 'pane-tabs');
  const body = el('div', 'pane-body');
  const foot = el('div', 'pane-footwrap');
  const draftWrap = el('div', 'pane-draft');
  const draft = el('textarea');
  draft.placeholder = 'Write the next prompt while it works. Saved forever, never sent by this UI.';
  draft.title = '↑ / ↓ walk through your earlier prompts (once the caret cannot move further)  ·  Ctrl+Z or ⌘Z undoes, including a recall or a Clear';
  /* Model and effort, like the extension. The dropdown shows what is REALLY in
     use — read out of the transcript, which is where Claude Code records the
     model and effort of every message — and changing it sends the same
     `/model …` command you would type. So the control cannot claim a setting
     that did not take. */
  const cfgRow = el('div', 'panecfg');
  const mkSel = (kind, opts) => {
    const s = el('select', 'cfgsel');
    // An explicit "unknown". Without it an unread value showed the first option
    // — a dropdown reading "low" for an agent running on xhigh states a fact
    // that is not true.
    s.appendChild(Object.assign(el('option'), { value: '', textContent: '—' }));
    s.title = kind === 'model'
      ? 'Model — sends /model. Claude Code also saves this as your default for NEW sessions.'
      : 'Effort — sends /effort. Claude Code also saves this as your default for NEW sessions.';
    for (const o of opts) s.appendChild(Object.assign(el('option'), { value: o, textContent: o }));
    s.onchange = () => { if (s.value) sendSessionCommand(key, `/${kind} ${s.value}`); };
    return s;
  };
  const selModel = mkSel('model', ['opus', 'sonnet', 'haiku', 'fable']);
  const selEffort = mkSel('effort', ['low', 'medium', 'high', 'xhigh', 'max']);
  const rtBadge = el('span', 'cfgruntime');
  rtBadge.hidden = true;
  cfgRow.append(rtBadge, el('span', 'cfglabel', 'model'), selModel, el('span', 'cfglabel', 'effort'), selEffort);

  const bar = el('div', 'draftbar');
  const clip = el('button', 'btn ghost small', '📎');
  clip.title = 'Attach a file — it is saved locally and referenced in the prompt';
  const picker = el('input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true;
  const hint = el('span', 'hint');
  const insert = el('button', 'btn ghost small', 'Insert ⇧⌘↵');
  insert.title = 'Types it into the real terminal without pressing Enter';
  const send = el('button', 'btn primary small', 'Send ⌘↵');
  send.title = 'Attaches if needed, waits for the prompt, pastes and presses Enter — one click';
  const clear = el('button', 'btn ghost small', 'Clear');
  bar.append(clip, picker, hint, el('div', 'spacer'), clear, insert, send);
  draftWrap.append(cfgRow, draft, bar);

  const termWrap = el('div', 'pane-term'); termWrap.hidden = true;
  const termBar = el('div', 'termbar');
  const termTitle = el('span', 'termtitle');
  const termOut = el('button', 'btn ghost small', '⇱ Own pane');
  termOut.title = 'Move the terminal into its own pane, next to the conversation';
  const termApp = el('button', 'btn ghost small', 'Terminal.app');
  termApp.title = 'Open a real Terminal.app window; it returns you to the browser and closes itself';
  const termClose = el('button', 'btn ghost small', 'Close ✕');
  termBar.append(termTitle, el('div', 'spacer'), termOut, termApp, termClose);
  const termHost = el('div', 'termhost');
  termHost.dataset.termkey = key;
  termWatch.observe(termHost);
  termWrap.append(termBar, termHost);

  root.append(head, tabs, body, foot, termWrap, draftWrap);

  tightWatch.observe(root);
  const st = { root, head, tabs, body, foot, draft, hint, termWrap, termTitle, termHost,
    selModel, selEffort, rtBadge, navIdx: null, navTop: null,
    history: [], histIdx: null, histStash: null, replacing: false,
    tab: 'chat', tailSession: null, tailOffset: 0, seen: new Set(), term: null, ws: null, loading: false };
  PD.set(key, st);

  // Touching a pane is what counts as reading it — not merely having it open,
  // and it is also how the sidebar learns where your cursor is.
  const focusHere = () => setFocus(key);
  root.addEventListener('pointerdown', () => {
    focusHere();
    if (findAgent(key)?.unread) markRead(key);   // markRead patches its own row
    maybePrewarm(key);
  }, true);
  root.addEventListener('focusin', focusHere);

  for (const [id, label] of [['chat', 'Conversation'], ['timeline', 'Timeline'], ['intent', 'Brief']]) {
    const b = el('button', 'tab' + (id === 'chat' ? ' active' : ''), label);
    b.onclick = () => { st.tab = id; paintTabs(key); loadTab(key); };
    tabs.appendChild(b);
  }
  // Tool traffic is context; the answers are why you opened this. One switch
  // hides everything that carries no words, applied by CSS so it is instant.
  tabs.appendChild(el('div', 'spacer'));

  const nav = el('div', 'promptnav');
  const navUp = el('button', 'pn-btn', '↑');
  navUp.title = 'Your previous prompt  (⌥↑ outside the draft box)';
  const navPos = el('span', 'pn-pos', '–');
  const navDown = el('button', 'pn-btn', '↓');
  navDown.title = 'Your next prompt — past the last one, the live end  (⌥↓ outside the draft box)';
  navUp.onclick = () => jumpPrompt(key, -1);
  navDown.onclick = () => jumpPrompt(key, +1);
  nav.append(el('span', 'pn-label', 'my prompts'), navUp, navPos, navDown);
  tabs.appendChild(nav);

  // Two labels, one button: the long one is the honest name, the short one is
  // what survives a narrow pane. CSS picks; the button never changes meaning.
  const only = el('button', 'tab tabtoggle');
  only.append(el('span', 'lbl-long', 'Answers only'), el('span', 'lbl-short', 'Answers'));
  only.title = 'Hide everything that carries no words';
  only.onclick = () => { PREFS.answersOnly = !PREFS.answersOnly; savePrefs(); applyAnswersOnly(); };
  tabs.appendChild(only);

  // Scrolling back down to the bottom YOURSELF means the same thing as pressing
  // ↓ past the last prompt: you are at the live end again.
  //
  // "Yourself" is the whole difficulty. The jump writes scrollTop too, and when
  // the last prompt happens to sit near the end — measured: 0 px from it — the
  // landing looked exactly like you had scrolled down, so the position flipped
  // straight back to "at end" and ↑ could never walk past the last prompt. The
  // scroll event cannot say who caused it, so remember WHERE we put you: the
  // event that lands on our own pixel is ours, anything else is yours.
  body.addEventListener('scroll', () => {
    if (st.navIdx == null) return;
    if (st.navTop != null && Math.abs(body.scrollTop - st.navTop) < 2) return;
    if (atBottom(body)) { st.navIdx = null; paintNav(key); }
  }, { passive: true });

  st.navPos = navPos; st.navUp = navUp; st.navDown = navDown;
  st.insertBtn = insert; st.sendBtn = send;
  draft.value = drafts.get(key)?.text ?? drafts.get(key) ?? '';
  draft.addEventListener('input', () => {
    setDraft(key, draft.value); autoGrow(draft);
    // Typing a reply is reading, as much as clicking into the pane is.
    if (findAgent(key)?.unread) markRead(key);
    /* ONE ROW, not 430. The only thing a keystroke changes in the sidebar is
       this agent's draft mark, and a full pass per character was 13ms of script
       plus a style recalculation over every row — on the thread that is
       supposed to be showing the character you just typed. */
    patchRow(key);
    disarm(key);   // the terminal still holds the old text; Send would fire that
    /* WARM THE TERMINAL WHILE YOU TYPE. The attach costs the same seconds
       whether it starts now or on the click — starting it on the first
       keystroke means it is usually up by the time you press Send. Only on a
       live agent (attaching wakes a stopped one, ~0.46 GB, and a typed note is
       not yet a decision to send), only once per pane, never stealing focus. */
    if (!st.prewarmed && draft.value.trim() && findAgent(key)?.alive && st.ws?.readyState !== 1) {
      st.prewarmed = true;
      ensureTerm(key, { focus: false }).catch(() => {});
    }
    // Editing a recalled line stops the browsing, exactly like a shell. Our own
    // replacements also fire `input`, hence the flag.
    if (!st.replacing && st.histIdx != null) { st.histIdx = null; st.histStash = null; paintHistHint(key); }
  });
  draft.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (e.repeat) return;                       // a held key is one press, not a burst of sends
      if (e.shiftKey) insertDraft(key); else sendNow(key);
      return;
    }
    // ⌘Z is native on macOS; Ctrl+Z is not bound there at all, and it is what
    // was asked for. Both end up in the same browser undo stack.
    if (e.ctrlKey && !e.metaKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      try { document.execCommand(e.shiftKey ? 'redo' : 'undo'); } catch {}
      setDraft(key, draft.value); autoGrow(draft); patchRow(key);
      return;
    }
    if (e.ctrlKey && !e.metaKey && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      try { document.execCommand('redo'); } catch {}
      setDraft(key, draft.value); autoGrow(draft); patchRow(key);
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (draft.selectionStart !== draft.selectionEnd) return;   // a selection is an edit, not navigation
    const dir = e.key === 'ArrowUp' ? -1 : 1;
    requestAnimationFrame(() => {
      // Let the browser move the caret first, then look at where it LANDED:
      // at the very start (↑) or the very end (↓) means there was nowhere left
      // to go, and the press was a request for history.
      //
      // "did the caret move?" was the first rule and it was one notch too
      // strict: after a recall the caret sits at the end of a one-line entry,
      // ↑ moves it to 0 — a real move — so walking further back needed two
      // presses. Landing on the edge covers both cases and stays wrap-safe,
      // because the browser, not us, decides what a line is.
      const at = draft.selectionStart;
      if (at !== draft.selectionEnd) return;
      if (dir < 0 ? at !== 0 : at !== draft.value.length) return;
      recallHistory(key, dir);
    });
  });
  insert.onclick = () => insertDraft(key);
  send.onclick = () => sendNow(key);
  clear.onclick = () => { setDraftText(key, ''); st.histIdx = null; st.histStash = null; paintHistHint(key); };

  // Attach: drag onto the box, paste, or the paperclip — all three land in the
  // same place, as a path in the text. The text stays the single truth, so an
  // attachment is saved, restored and sent exactly like the words around it.
  clip.onclick = () => picker.click();
  picker.onchange = () => { attachFiles(key, [...picker.files]); picker.value = ''; };
  draft.addEventListener('dragover', (e) => { e.preventDefault(); draftWrap.classList.add('dropping'); });
  draft.addEventListener('dragleave', () => draftWrap.classList.remove('dropping'));
  draft.addEventListener('drop', (e) => {
    draftWrap.classList.remove('dropping');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) { e.preventDefault(); attachFiles(key, files); }
  });
  draft.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); attachFiles(key, files); }
  });
  termOut.onclick = () => undockTerm(key);
  termClose.onclick = () => closeTerm(key);
  termApp.onclick = async () => {
    const a = findAgent(key); if (!a?.id) return;
    const r = await (await fetch('/api/open-terminal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: a.id, backTo: navigator.userAgent.includes('Chrome') ? 'Google Chrome' : 'Safari' }),
    })).json();
    logCmd(r);
  };
  body.addEventListener('scroll', () => { if (atBottom(body)) st.jumpEl && (st.jumpEl.hidden = true); });
  requestAnimationFrame(() => autoGrow(draft));
  return root;
}

function paintTabs(key) {
  const st = PD.get(key); if (!st) return;
  [...st.tabs.children].forEach((b, i) => b.classList.toggle('active', ['chat', 'timeline', 'intent'][i] === st.tab));
}

/* The pane carries BOTH signals at once: its chrome is the agent's colour, and
   its background lightness is the state — grey while it runs, black when it
   rests, amber when it wants you. That is the from-two-metres read. */
function updatePane(key) {
  const st = PD.get(key); if (!st) return;
  const a = findAgent(key);
  // The head is now signature-guarded, so a head written by this branch has to
  // drop the signature with it — otherwise the agent comes back and its head
  // still reads "Session gone".
  if (!a) { st.headSig = null; st.head.textContent = ''; st.head.appendChild(el('div', 'ph-title', 'Session gone')); return; }
  const l = lane(a);
  st.root.style.setProperty('--c', colorOf(a));
  st.root.classList.add(patClass(a));
  /* The pinned pane is LIGHTER, not black — from two metres that is "this is
     the one I am keeping", and it is a different channel from the lane, which
     still owns the colour and the wave. */
  st.root.classList.toggle('pinned', Boolean(a.pinned));
  // Set the lane, keep everything else. Assigning className outright wiped the
  // size classes (`tight`, `narrow`, `vnarrow`) on every refresh; the observer
  // only re-adds them when the pane actually RESIZES, so once a pane sat at its
  // minimum width they were gone for good — which is how the jumper's ↓ ended
  // up clipped in exactly the panes the narrow rules were written for.
  for (const x of LANES) st.root.classList.toggle(x, x === l);

  /* THE HEAD IS REBUILT ONLY WHEN IT SAYS SOMETHING ELSE.

     This function runs for every open pane on every agents payload — 1.5
     seconds apart — and it threw away the whole head and built thirty nodes and
     seven buttons again, whatever had happened. Measured with five panes open:
     25ms each, 121ms per payload, all of it recreating identical markup.

     The signature carries everything the head DRAWS, including where the pane
     sits (the ◀ ▶ ▲ ▼ buttons are enabled by position). Miss a field and the
     head goes stale, which is worse than slow — so the clock is deliberately
     NOT in here: the ticking parts write into the nodes they own
     (`data-live`, `data-ago`), the same mechanism the sidebar rows use. */
  const at = locate(key);
  const headSig = [
    l, a.name, a.alive ? 1 : 0, a.pinned ? 1 : 0, a.id, a.cwd, a.shells, a.waitingFor,
    a.runtime, at ? at.ci : -1, at ? at.pi : -1, at ? LAYOUT.cols[at.ci].panes.length : 0,
    LAYOUT.cols.length, PREFS.archiveStops ? 1 : 0,
  ].join('\u0001');
  if (st.headSig !== headSig) { st.headSig = headSig; paintPaneHead(key, a, l, at); }

  if (st.rtBadge) {
    const rt = a.runtime && a.runtime !== 'claude' ? a.runtime : '';
    st.rtBadge.hidden = !rt;
    st.rtBadge.textContent = rt ? runtimeById(rt).label : '';
    st.rtBadge.title = rt ? (runtimeById(rt).note || (runtimeById(rt).anthropicApi
      ? `Runs on ${runtimeById(rt).label} (Anthropic API).`
      : `Runs on ${runtimeById(rt).label}, not on the Anthropic API.`)) : '';
  }

  const alias = (m) => !m ? '' : /opus/.test(m) ? 'opus' : /sonnet/.test(m) ? 'sonnet' : /haiku/.test(m) ? 'haiku' : /fable/.test(m) ? 'fable' : m;
  if (st.selModel && document.activeElement !== st.selModel) {
    const v = alias(a.model);
    if (v && ![...st.selModel.options].some((o) => o.value === v)) st.selModel.appendChild(Object.assign(el('option'), { value: v, textContent: v }));
    if (st.selModel.value !== v) st.selModel.value = v;
  }
  if (st.selEffort && document.activeElement !== st.selEffort && st.selEffort.value !== (a.effort || '')) st.selEffort.value = a.effort || '';

  if (st.tab === 'chat' && st.tailSession !== a.sessionId) loadTab(key);
  else if (st.tab === 'chat') { tailPane(key); paintFoot(key); }
}

/* The head itself — the expensive half, run only when the signature above
   moves. Every button closes over the record it was drawn from, which is why
   every field a button reads is in that signature. */
function paintPaneHead(key, a, l, at) {
  const st = PD.get(key); if (!st) return;

  // NOTE: an open pane deliberately does NOT clear unread any more. It used to,
  // on the theory that "open means looked at" — but with several panes open you
  // are looking at one of them, and every agent that finished in the others had
  // its unread wiped on the next refresh. Reading is now an act: clicking into
  // the pane (below) or the ○ button.
  st.head.textContent = '';
  const line1 = el('div', 'ph-line');
  line1.appendChild(el('span', `dot ${l}` + (a.alive ? '' : ' hollow')));
  const titleEl = el('div', 'ph-title', a.name || a.id || 'Session');
  titleEl.title = a.name || a.id || '';   // the rest of a prompt-as-name, on hover
  line1.appendChild(titleEl);
  // The seven buttons live in ONE box. Without it the row wrapped through the
  // MIDDLE of the group — ◀ ▶ ▲ next to the title, ▼ ● ⌫ ✕ on the line below.
  // As a single item they either all fit beside the name or all move under it.
  const icons = el('div', 'ph-icons');
  const mv = (glyph, title, dir, enabled) => {
    const b = el('button', 'ph-ico', glyph); b.title = title;
    b.disabled = !enabled;
    b.onclick = () => movePane(key, dir);
    icons.appendChild(b);
  };
  if (at) {
    const col = LAYOUT.cols[at.ci];
    mv('◀', 'Move to the column on the left', 'left', true);
    mv('▶', 'Move to the column on the right', 'right', true);
    mv('▲', 'Move up in this column', 'up', at.pi > 0);
    mv('▼', 'Move down in this column', 'down', at.pi < col.panes.length - 1);
  }
  /* The pin sits with the buttons that decide WHERE this chat is, not with the
     ones that end it: it pins the row to the top of the list on the left and
     lifts this pane out of the black. */
  const pin = el('button', 'ph-ico' + (a.pinned ? ' on' : ''));
  pin.appendChild(pinIcon(a.pinned));
  pin.title = a.pinned
    ? 'Unpin — it goes back to its place in the sort'
    : 'Pin to the top — it stays in sight while you work somewhere else';
  pin.onclick = () => setPinned(key, !a.pinned);
  icons.appendChild(pin);
  // A filled envelope, because that is the state this button LEAVES behind.
  const unr = el('button', 'ph-ico'); unr.appendChild(mailIcon(true));
  unr.title = 'Mark unread and close';
  unr.onclick = () => { markUnread(key); closePane(key); };
  icons.appendChild(unr);
  const arc = el('button', 'ph-ico', '⌫');
  arc.title = PREFS.archiveStops && a.alive && TERMINAL.has(l)
    ? 'Archive — hides it and runs `claude stop` to free ~0.46 GB. The conversation is kept.'
    : 'Archive — hides it here. The conversation is kept.';
  arc.onclick = () => setArchived(key, true);
  icons.appendChild(arc);
  const close = el('button', 'ph-close', '✕'); close.title = 'Close pane';
  close.onclick = () => closePane(key);
  icons.appendChild(close);
  line1.appendChild(icons);
  st.head.appendChild(line1);

  const line2 = el('div', 'ph-line2');
  const chip = el('span', 'state-chip ' + l);
  if (l === 'working') {
    chip.appendChild(dotsEl());
    const t = el('span', null, activityText(a)); t.dataset.live = key; t.title = TIMER_TITLE;
    chip.appendChild(t);
  } else chip.textContent = LANE_LABEL[l];
  line2.appendChild(chip);
  if (l !== 'working' && shellNote(a)) {
    const sh = el('span', 'badge-shell', shellNote(a));
    sh.title = 'Its turn is over. Background shells are still running, which is why the daemon calls the process busy.';
    line2.appendChild(sh);
  }
  line2.appendChild(el('span', 'ph-sub', `${a.id ? a.id + ' · ' : ''}${short(a.cwd) || ''}`));
  st.head.appendChild(line2);

  const acts = el('div', 'ph-acts');
  if (a.id) {
    const reply = el('button', 'btn primary small', a.alive ? 'Reply ⏎' : 'Open & reply');
    reply.onclick = () => openTerm(key);
    acts.appendChild(reply);
    const mk = (label, cls, fn) => { const b = el('button', 'btn small ' + cls, label); b.onclick = fn; acts.appendChild(b); };
    if (a.alive) mk('Stop', 'ghost danger', () => act('stop', a.id));
    mk('Respawn', 'ghost', () => act('respawn', a.id));
    mk('Delete', 'ghost danger', () => { if (confirm(`claude rm ${a.id}\n\nDeletes the session and its worktree. Sure?`)) act('rm', a.id); });
  }
  st.head.appendChild(acts);
}

/* ------------------------------------------------------------- transcript */
const atBottom = (p) => p.scrollHeight - p.scrollTop - p.clientHeight < 140;

async function loadTab(key) {
  const st = PD.get(key), a = findAgent(key);
  if (!st || !a) return;
  st.body.textContent = '';
  st.foot.textContent = '';
  st.navIdx = null; paintNav(key);
  if (st.tab === 'timeline') return loadTimeline(key);
  if (st.tab === 'intent') {
    const d = el('div', 'md'); d.innerHTML = a.intent ? md(a.intent) : '<p class="nores">No stored brief.</p>';
    st.body.appendChild(d); return;
  }
  if (!a.sessionId) { st.body.appendChild(el('div', 'nores', 'No transcript yet.')); return; }

  st.tailSession = a.sessionId; st.tailOffset = 0; st.loading = true;
  st.history = []; st.histIdx = null; st.histStash = null;
  st.seen = new Set();   // transcript line ids already on screen
  st.body.appendChild(el('div', 'nores', 'loading…'));
  let data;
  try { data = await (await fetch(`/api/transcript?session=${encodeURIComponent(a.sessionId)}`)).json(); }
  catch (e) { st.body.textContent = 'Error: ' + e.message; st.loading = false; return; }
  st.loading = false;
  st.body.textContent = '';
  if (data.error) { st.body.appendChild(el('div', 'nores', data.error)); return; }
  st.tailOffset = data.offset || data.size || 0;
  if (data.truncated) st.body.appendChild(el('div', 'nores', `Showing the end of ${(data.size / 1e6).toFixed(1)} MB.`));
  for (const ev of data.events) {
    if (!unseen(st, ev)) continue;
    st.body.appendChild(renderMsg(ev));
    if (ev.ts) st.lastEventTs = Date.parse(ev.ts);
    if (ev.role === 'user' && ev.prompt) pushHistory(st, promptTextOf(ev));
  }
  paintFoot(key); applyAnswersOnly();
  st.body.scrollTop = st.body.scrollHeight;
  st.navIdx = null; paintNav(key);
}

/* A LINE IS DRAWN ONCE. The tail is asked for from three places — its own
   2 s clock, every agents payload, and the tab coming back — and they raced:
   two calls in flight from the SAME offset both got the same delta and both
   appended it, so an answer showed two, three, four times over. The transcript
   itself never repeats a line (measured over 10,456 assistant lines: zero
   consecutive duplicates), so the id of the line is the whole truth: seen it,
   skip it. Two genuinely separate answers with the same words have two ids
   and both stay. */
function unseen(st, ev) {
  if (!ev.uuid) return true;
  if (st.seen.has(ev.uuid)) return false;
  st.seen.add(ev.uuid);
  return true;
}

async function tailPane(key) {
  const st = PD.get(key), a = findAgent(key);
  if (!st || !a || st.loading || st.tailing || st.tab !== 'chat') return;
  if (!a.sessionId || st.tailSession !== a.sessionId) return;
  // Skipping on size is an optimisation that borrows its truth from the agents
  // feed. When that feed is stale the shortcut is a lie, so it only applies
  // while the feed is demonstrably fresh.
  if (a.tsize != null && a.tsize <= st.tailOffset && Date.now() - LAST_AGENTS_AT < 6000) return;
  // One read in flight per pane. The id check below is the belt; this is the
  // braces — without it the second caller re-fetches the same bytes for nothing.
  st.tailing = true;
  const from = st.tailOffset, session = st.tailSession;
  let data;
  try { data = await (await fetch(`/api/transcript?session=${encodeURIComponent(a.sessionId)}&from=${from}`)).json(); }
  catch { return; } finally { st.tailing = false; }
  if (!data || data.error || !data.delta) return;
  // The pane was reloaded or switched while we waited: this delta belongs to a
  // body that no longer exists.
  if (st.loading || st.tailSession !== session || st.tailOffset !== from) return;
  st.tailOffset = data.offset;
  if (!data.events?.length) return;
  const stick = atBottom(st.body);
  for (const ev of data.events) {
    if (!unseen(st, ev)) continue;
    st.body.appendChild(renderMsg(ev, true));
    if (ev.ts) st.lastEventTs = Date.parse(ev.ts);
    if (ev.role === 'user' && ev.prompt) pushHistory(st, promptTextOf(ev));
  }
  paintFoot(key); applyAnswersOnly(); paintNav(key);
  if (stick) st.body.scrollTop = st.body.scrollHeight;
}

/* The foot always answers "is it still going?". The quiet states get a line
   too, because otherwise "finished" and "the UI is stuck" look identical. */
function paintFoot(key) {
  const st = PD.get(key), a = findAgent(key);
  if (!st || !a || st.tab !== 'chat') return;
  const l = lane(a);
  // An auto-stop keeps the lane (see AUTO-STOP in server.mjs), so the guard has
  // to see it separately or the note would only appear after a reload.
  const fk = a.autoStoppedAt ? l + ':auto' : l;
  if (st.footLane === fk) return;
  st.footLane = fk;
  st.foot.textContent = '';
  const f = el('div', 'livefoot ' + l);
  if (l === 'working') {
    f.appendChild(dotsEl());
    const t = el('span', 'lf-text', activityText(a)); t.dataset.live = key; t.title = TIMER_TITLE;
    f.appendChild(t);
    const note = el('span', 'lf-hint', 'still working');
    note.dataset.foothint = key;
    f.appendChild(note);
  } else if (l === 'needs') {
    f.appendChild(el('span', 'lf-mark', '!'));
    f.appendChild(el('span', 'lf-text', a.waitingFor ? `Waiting on you — ${a.waitingFor}` : 'Waiting on you'));
    const b = el('button', 'btn primary small', 'Reply ⏎'); b.onclick = () => openTerm(key);
    f.appendChild(b);
  } else if (l === 'failed') { f.append(el('span', 'lf-mark', '×'), el('span', 'lf-text', 'Ended with an error')); }
  else if (l === 'stopped') { f.append(el('span', 'lf-mark', '■'), el('span', 'lf-text', 'Stopped. The conversation is kept.')); }
  else if (l === 'done') {
    f.appendChild(el('span', 'lf-mark', '✓'));
    // This foot is built ONCE per lane (see the footLane guard above), so the
    // "ago" cannot be baked into the string — it sat at "12s ago" for an hour.
    // The clock rides on the node and the 1s tick rewrites it.
    const at = a.laneAt || (a.updatedAt ? Date.parse(a.updatedAt) : 0);
    const t = el('span', 'lf-text', 'Finished');
    if (at) { t.textContent = `Finished · ${ago(at)} ago`; t.dataset.ago = String(at); t.dataset.agoPrefix = 'Finished · '; t.dataset.agoSuffix = ' ago'; }
    f.appendChild(t);
  }
  else { f.append(el('span', 'lf-mark', '·'), el('span', 'lf-text', a.alive ? 'Idle — waiting for your next prompt' : 'Process exited. Reply to wake it.')); }
  if (a.autoStoppedAt && (l === 'done' || l === 'needs')) {
    const h = el('span', 'lf-hint', 'stopped to free RAM · reply resumes it');
    h.title = `Auto-stopped ${ago(a.autoStoppedAt)} ago. The conversation is kept.`;
    f.appendChild(h);
  }
  st.foot.appendChild(f);
}

/* ------------------------------------------------------- jump to my prompts */
/* A long transcript is mostly tool traffic. The two questions you ask of it
   constantly are "what did I ask?" and "where does it stand right now?", so
   both get a control instead of a scroll wheel: ↑ walks back through your own
   turns, ↓ walks forward and — past the last one — lands on the live end.
   The list is queried from the DOM every time instead of being cached, so
   messages that arrive while you are reading are simply part of it. */
const promptEls = (key) => [...(PD.get(key)?.body?.querySelectorAll('.msg.user.prompt') || [])];

function paintNav(key) {
  const st = PD.get(key); if (!st?.navPos) return;
  const n = promptEls(key).length;
  const at = st.navIdx;
  const end = at == null;
  st.navPos.textContent = !n ? '–' : end ? String(n) : `${at + 1}/${n}`;
  st.navPos.classList.toggle('atend', end);
  st.navPos.title = !n ? 'No prompts of yours in the part loaded here'
    : end ? `At the live end · ${n} prompt${n === 1 ? '' : 's'} above`
    : `Your prompt ${at + 1} of ${n}`;
  if (st.navUp) st.navUp.disabled = !n || at === 0;
  if (st.navDown) st.navDown.disabled = !n && end;
}

function jumpPrompt(key, dir) {
  const st = PD.get(key); if (!st || st.tab !== 'chat') return;
  const list = promptEls(key);
  const toEnd = () => { st.navIdx = null; st.navTop = null; st.body.scrollTop = st.body.scrollHeight; paintNav(key); };
  if (!list.length) return toEnd();
  let i = st.navIdx;
  if (dir < 0) i = (i == null) ? list.length - 1 : Math.max(0, i - 1);
  else if (i == null || i >= list.length - 1) return toEnd();
  else i += 1;
  st.navIdx = i;
  const target = list[i];
  // Positioned by live rectangles, not offsetTop: the body is not guaranteed to
  // be the offset parent, and `Answers only` can hide messages in between.
  const br = st.body.getBoundingClientRect(), tr = target.getBoundingClientRect();
  st.body.scrollTop += tr.top - br.top - 12;
  st.navTop = st.body.scrollTop;   // the pixel that proves the next scroll was ours
  target.classList.remove('jumped'); void target.offsetWidth; target.classList.add('jumped');
  paintNav(key);
}

function applyAnswersOnly() {
  const on = !!PREFS.answersOnly;
  for (const k of paneKeys()) {
    const st = PD.get(k); if (!st?.body) continue;
    st.body.classList.toggle('textonly', on);
    const btn = st.tabs?.querySelector('.tabtoggle');
    if (btn) btn.classList.toggle('active', on);
    if (on && !st.body.querySelector('.msg:not(.notext)')) {
      if (!st.body.querySelector('.emptyfilter')) st.body.appendChild(el('div', 'nores emptyfilter', 'No written answers in the part loaded here.'));
    } else st.body.querySelector('.emptyfilter')?.remove();
  }
}

function renderMsg(ev, isNew) {
  const onlyToolResults = ev.role === 'user' && ev.blocks.every((b) => b.t === 'tool_result');
  const role = onlyToolResults ? 'tool' : ev.role;
  // A question and a plan-for-approval carry no `text` block, so both used to be
  // filed as plumbing: greyed, folded shut, and — worst of all — HIDDEN by
  // `Answers only`, the switch whose whole job is to leave only what matters.
  // Measured on one real session: 442 messages, 384 of them tool-only, 77% of
  // the scroll height collapsed tool rows, and the one message that asked the
  // user a question sat in there as row 385.
  const asks = ev.blocks.some((b) => b.ask || b.plan);
  const answers = ev.blocks.some((b) => b.t === 'tool_result' && ASK_IDS.has(b.forId));
  // "carries words" is the thing the filter keeps — a message made only of tool
  // calls is context no matter which role it came from
  const hasText = ev.blocks.some((b) => b.t === 'text') || asks || answers;
  for (const b of ev.blocks) if (b.ask && b.id) ASK_IDS.add(b.id);
  // `.prompt` is the server's verdict on "you actually typed this" — the jumper
  // and the gutter dot both read it, so they can never disagree.
  const mine = role === 'user' && ev.prompt;
  const m = el('div', `msg ${role}${mine ? ' prompt' : ''}${hasText ? '' : ' notext'}${asks ? ' asks' : ''}${answers ? ' answers' : ''}${ev.sidechain ? ' side' : ''}${isNew ? ' fresh' : ''}`);
  const head = el('div', 'msg-head');
  head.appendChild(el('span', 'who', role === 'user' ? 'You' : role === 'assistant' ? 'Claude' : role === 'tool' ? 'Tool' : role === 'summary' ? 'Context carried over' : 'System'));
  if (ev.sidechain) head.appendChild(el('span', '', 'subagent'));
  if (ev.ts) head.appendChild(el('span', '', new Date(ev.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })));
  m.appendChild(head);
  const b = el('div', 'bubble');
  // The carry-over is context, not a turn: folded shut, so it costs one line
  // instead of a screenful pretending to be something you said.
  if (role === 'summary') {
    const txt = ev.blocks.map((x) => x.text || '').join('\n');
    b.appendChild(fold('tool', 'Summary of the earlier conversation', txt, `${txt.split('\n').length} lines`));
    m.appendChild(b);
    return m;
  }
  for (const bl of ev.blocks) {
    if (bl.t === 'text') { const d = el('div', 'md'); d.innerHTML = md(bl.text); b.appendChild(d); }
    else if (bl.t === 'thinking') b.appendChild(fold('think', 'thought', bl.text));
    else if (bl.t === 'tool_use' && bl.ask) b.appendChild(askCard(bl.ask));
    else if (bl.t === 'tool_use' && bl.plan) b.appendChild(planCard(bl.plan));
    else if (bl.t === 'tool_use') b.appendChild(fold('tool', bl.name, bl.input, 'call'));
    else if (bl.t === 'tool_result' && ASK_IDS.has(bl.forId)) b.appendChild(answerCard(bl.text));
    else if (bl.t === 'tool_result') b.appendChild(fold('tool', bl.isError ? 'Error' : 'Result', bl.text, `${bl.text.split('\n').length} lines`, bl.isError));
    else if (bl.t === 'image') b.appendChild(el('div', 'r-meta', '[image]'));
  }
  m.appendChild(b);
  return m;
}

/* Which tool_use ids were questions. Filled while rendering, read one message
   later when the answer arrives — which works for a full load and for a delta
   that splits the two, because the pairing is by id, not by adjacency. */
const ASK_IDS = new Set();

function askCard(questions) {
  const d = el('div', 'askcard');
  d.appendChild(el('div', 'ask-tag', 'Waiting on you'));
  for (const q of questions) {
    const h = el('div', 'ask-q');
    if (q.header) h.appendChild(el('span', 'ask-chip', q.header));
    h.appendChild(el('span', 'ask-qtext', q.q));
    d.appendChild(h);
    for (const o of q.options || []) {
      const row = el('div', 'ask-opt');
      row.appendChild(el('div', 'ask-label', o.label));
      if (o.desc) row.appendChild(el('div', 'ask-desc', o.desc));
      d.appendChild(row);
    }
    if (q.multi) d.appendChild(el('div', 'ask-note', 'Several answers possible.'));
  }
  // Deliberately not clickable: answering here would be a second way to drive
  // the agent, and this window only ever watches.
  d.appendChild(el('div', 'ask-note', 'Answer in Claude Code — this view only shows it.'));
  return d;
}
function planCard(text) {
  const d = el('div', 'askcard plan');
  d.appendChild(el('div', 'ask-tag', 'Plan for your approval'));
  const md_ = el('div', 'md'); md_.innerHTML = md(text); d.appendChild(md_);
  return d;
}
function answerCard(text) {
  const d = el('div', 'answercard');
  d.appendChild(el('div', 'ask-tag', 'Your answer'));
  d.appendChild(Object.assign(el('div', 'ans-text'), { textContent: text }));
  return d;
}
function fold(kind, title, body, sub, isError) {
  const d = el('details', 'tool ' + (kind === 'think' ? 'think' : ''));
  const s = el('summary');
  s.innerHTML = `<span class="${isError ? 'toolerr' : 'toolname'}">${esc(title)}</span>` + (sub ? `<span>${esc(sub)}</span>` : '');
  d.append(s, Object.assign(el('pre'), { textContent: body }));
  return d;
}

async function loadTimeline(key) {
  const st = PD.get(key), a = findAgent(key);
  if (!a?.id) { st.body.appendChild(el('div', 'nores', 'Background agents only.')); return; }
  const { rows } = await (await fetch('/api/timeline?id=' + encodeURIComponent(a.id))).json();
  if (!rows.length) { st.body.appendChild(el('div', 'nores', 'No state changes yet.')); return; }
  for (const row of rows.slice().reverse()) {
    const tr = el('div', 'tl-row');
    const w = el('div');
    w.appendChild(el('div', 'tl-when', row.at ? new Date(row.at).toLocaleString('en-GB') : ''));
    w.appendChild(el('div', 'tl-state ' + (row.state || ''), row.state || ''));
    const d = el('div', 'md'); d.innerHTML = md(row.detail || row.text || '');
    tr.append(w, d); st.body.appendChild(tr);
  }
}

/* --------------------------------------------------- draft history & undo */
/* WHY THE VALUE IS NEVER ASSIGNED DIRECTLY.
   Setting `textarea.value = x` wipes the browser's own undo stack — after a
   history recall or a Clear, Ctrl/⌘-Z had nothing left to undo. Replacing the
   text as an EDIT (select all, then insertText) keeps that stack intact, so
   undo composes with normal typing and needs no shadow stack of our own.
   `execCommand` is deprecated and still the only way to do this; the direct
   assignment stays as the fallback. */
function setDraftText(key, text, { focus = true } = {}) {
  const st = PD.get(key); if (!st) return;
  const ta = st.draft;
  const had = document.activeElement;
  if (focus && had !== ta) ta.focus();
  // The flag has to be up BEFORE the edit: `execCommand` fires `input`
  // synchronously, and the input handler is what ends history browsing. Setting
  // it afterwards meant every recall cancelled its own position — the value
  // changed once and then ↑/↓ did nothing.
  st.replacing = true;
  let ok = false;
  if (document.activeElement === ta) {
    ta.setSelectionRange(0, ta.value.length);
    try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
  }
  if (!ok) ta.value = text;               // undo is lost, but the text is right
  setDraft(key, ta.value); autoGrow(ta); patchRow(key); disarm(key);
  st.replacing = false;
  if (focus && had !== ta && had?.focus) { /* leave focus in the box on purpose */ }
}

/* The history is what you actually asked this agent — read out of the
   transcript, which already knows which user lines were typed by you (the same
   flag the prompt jumper uses). That means it survives a restart, and it also
   contains prompts you typed straight into the terminal, which a store of
   "things this UI sent" never could. Consecutive duplicates collapse, like a
   shell. */
function pushHistory(st, text) {
  if (!st || !text) return;
  const t = text.trim(); if (!t) return;
  const h = (st.history ||= []);
  if (h[h.length - 1] === t) return;
  h.push(t);
  if (h.length > 200) h.shift();
}
const promptTextOf = (ev) => ev.blocks.filter((b) => b.t === 'text').map((b) => b.text).join('\n');

function paintHistHint(key) {
  const st = PD.get(key); if (!st) return;
  const h = st.history || [];
  if (st.histIdx == null) { if (/^history /.test(st.hint.textContent)) st.hint.textContent = ''; return; }
  st.hint.textContent = `history ${h.length - st.histIdx}/${h.length}`;
}

/* ↑/↓ recall — but ONLY when the caret could not move any further in that
   direction. A terminal prompt is one line, so ↑ is free there; a textarea is
   not, and stealing the cursor key would break every multi-line draft. So the
   browser gets the keystroke first, and one frame later we ask whether the
   caret actually moved: if it did, that press was cursor movement and we do
   nothing. This is wrap-safe by construction — no guessing where a soft-wrapped
   line begins. */
function recallHistory(key, dir) {
  const st = PD.get(key); if (!st) return;
  const h = st.history || [];
  if (!h.length) return;
  if (st.histIdx == null) {
    if (dir > 0) return;                       // nothing newer than what you wrote
    st.histStash = st.draft.value;
    st.histIdx = h.length - 1;
  } else {
    const next = st.histIdx + dir;
    if (next < 0) return;                      // oldest entry: stay there
    if (next >= h.length) {                    // past the newest: your own text back
      st.histIdx = null;
      setDraftText(key, st.histStash || '');
      st.histStash = null;
      paintHistHint(key);
      return;
    }
    st.histIdx = next;
  }
  setDraftText(key, h[st.histIdx]);
  st.draft.setSelectionRange(st.draft.value.length, st.draft.value.length);
  paintHistHint(key);
}

/* ------------------------------------------------------------- draft store */
/* Persisted on the server so they survive a server restart, a reboot and a
   crash — localStorage is only the instant-write mirror. */
const drafts = new Map();
const draftTimers = new Map();

let lsT = null;
function flushDrafts() {
  clearTimeout(lsT); lsT = null;
  try { localStorage.setItem('fleet.drafts', JSON.stringify([...drafts])); } catch {}
}
/* The debounce must never be the reason a draft is missing. Leaving the page is
   the one moment it cannot wait for, so it is written out right there. */
addEventListener('pagehide', flushDrafts);
/* …and the server copy too. localStorage alone is exactly what "clear the
   cache" throws away, so a draft typed in the last 500 ms before closing the
   tab has to leave with the tab. */
addEventListener('pagehide', () => {
  for (const [key, t] of draftTimers) {
    if (!t) continue;
    clearTimeout(t); draftTimers.set(key, null);
    const text = drafts.get(key)?.text || '';
    try { navigator.sendBeacon('/api/drafts', new Blob([JSON.stringify({ key, text })], { type: 'application/json' })); } catch {}
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) flushDrafts(); });
function setDraft(key, text) {
  if (text) drafts.set(key, { text, at: Date.now() }); else drafts.delete(key);
  /* The in-memory map is updated at once — everything that reads a draft reads
     that. Only the SERIALISATION is debounced: `JSON.stringify` over every
     draft you own ran on every single keystroke, and the store holds dozens of
     them, some thousands of characters long. The server write below was already
     debounced; this one was not. */
  clearTimeout(lsT);
  lsT = setTimeout(flushDrafts, 400);
  clearTimeout(draftTimers.get(key));
  draftTimers.set(key, setTimeout(() => {
    draftTimers.set(key, null);
    fetch('/api/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, text }) }).catch(() => {});
  }, 500));
}
async function loadDrafts() {
  try {
    const local = JSON.parse(localStorage.getItem('fleet.drafts') || '[]');
    for (const [k, v] of local) drafts.set(k, typeof v === 'string' ? { text: v, at: 0 } : v);
  } catch {}
  try {
    const { drafts: server } = await (await fetch('/api/drafts')).json();
    // The server file is the durable copy; newer wins so an offline edit is kept.
    // An entry with empty text is a TOMBSTONE — it has to take part in the vote
    // (that is the whole point: a deletion must be able to beat a stale mirror)
    // and is dropped afterwards, so nothing downstream ever sees an empty draft.
    for (const [k, v] of Object.entries(server || {})) {
      const cur = drafts.get(k);
      if (!cur || (v.at || 0) >= (cur.at || 0)) drafts.set(k, v);
    }
    /* A local copy that won the vote is newer than the durable one — a tab
       closed before its write left. Hand it to the server now, or it lives
       only in this browser's cache. */
    for (const [k, v] of drafts) {
      const s = server?.[k];
      if (v?.text && (!s || (v.at || 0) > (s.at || 0))) {
        fetch('/api/drafts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: k, text: v.text }) }).catch(() => {});
      }
    }
    for (const [k, v] of [...drafts]) if (!v?.text) drafts.delete(k);
    try { localStorage.setItem('fleet.drafts', JSON.stringify([...drafts])); } catch {}
  } catch {}
}
/* Export: every input box of THIS workspace — started agents and unstarted
   compose panes alike — as one .txt, entries separated by two blank lines.
   Read-only: it reads the draft map and the layout and changes neither. */
function exportInputs() {
  const parts = [];
  for (const k of paneKeys()) {
    if (isTerm(k)) continue;
    const t = (drafts.get(k)?.text || '').trim();
    if (t) parts.push(t);
  }
  const btn = $('#btnExport');
  if (!parts.length) { btn.textContent = 'empty'; setTimeout(() => { btn.textContent = '⇩ TXT'; }, 1500); return; }
  const url = URL.createObjectURL(new Blob([parts.join('\n\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `flotilla-inputs-${WS}-${new Date().toISOString().slice(0, 10)}.txt` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  btn.textContent = `${parts.length} ✓`; setTimeout(() => { btn.textContent = '⇩ TXT'; }, 1500);
}
/* The box grows with what you write, but never past a third of its own pane —
   a fixed 240px cap is too tall in a short pane and pushes its own buttons out
   of view. */
function autoGrow(ta) {
  const pane = ta.closest('.pane-col');
  const tight = pane?.classList.contains('tight');
  const floor = tight ? 36 : 58;
  const room = pane ? Math.max(floor, pane.clientHeight * (tight ? 0.22 : 0.34)) : 240;
  ta.style.height = 'auto';
  ta.style.height = Math.min(240, room, Math.max(floor, ta.scrollHeight)) + 'px';
}

/* One observer decides which panes are too short for their settings row. CSS
   alone cannot ask "how tall am I" without container queries, and guessing from
   the viewport is wrong the moment panes are stacked. */
/* Two independent squeezes, and mixing them up costs you the thing you were
   trying to protect:
     · HEIGHT decides how tall the draft box may grow      -> .tight
     · WIDTH decides what still fits in the tab row        -> .narrow / .vnarrow
   The jumper arrows were clipped in a pane that was 370px wide and 800px tall
   — not tight by any height measure, which is exactly why a height-keyed rule
   never fired. */
const LANES = Object.keys(LANE_LABEL);   // derived, so a new lane cannot be forgotten here

/* THE BOX SAYS WHEN THE TERMINAL HAS TO BE RE-MEASURED. It used to be asked on
   every pane pass — a forced layout per terminal, 1.5 seconds apart, for an
   answer that only changes when something actually resizes. */
const termWatch = new ResizeObserver((entries) => {
  for (const e of entries) fitTerm(e.target.dataset.termkey);
});

const tightWatch = new ResizeObserver((entries) => {
  for (const e of entries) {
    const w = e.contentRect.width, h = e.contentRect.height;
    const narrow = w < 520, vnarrow = w < 430;
    if (e.target.classList.contains('narrow') !== narrow) e.target.classList.toggle('narrow', narrow);
    if (e.target.classList.contains('vnarrow') !== vnarrow) e.target.classList.toggle('vnarrow', vnarrow);
    const tight = h < 380;
    if (e.target.classList.contains('tight') === tight) continue;
    e.target.classList.toggle('tight', tight);
    const ta = e.target.querySelector('.pane-draft textarea');
    if (ta) autoGrow(ta);
  }
});

/* Uploads each file and drops an `@path` reference into the draft — the same
   thing you would type yourself, and the same thing Claude Code's own remote
   attachments do. The file is written to ~/.flotilla/attachments, never
   into your project. */
async function attachFiles(key, files) {
  const st = PD.get(key); if (!st || !files.length) return;
  for (const f of files) {
    st.hint.textContent = `Attaching ${f.name}…`;
    let r;
    try {
      r = await (await fetch('/api/attach', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) },
        body: f,
      })).json();
    } catch { r = { error: 'upload failed' }; }
    if (r.error) { st.hint.textContent = `${f.name}: ${r.error}`; continue; }
    const ref = '@' + r.path;
    const cur = st.draft.value;
    st.draft.value = cur && !cur.endsWith('\n') ? `${cur}\n${ref}\n` : `${cur}${ref}\n`;
    setDraft(key, st.draft.value);
    autoGrow(st.draft); disarm(key);
    st.hint.textContent = `${r.name} attached (${r.size < 1024 ? r.size + ' B' : (r.size / 1024).toFixed(r.size < 102400 ? 1 : 0) + ' kB'})`;
  }
  patchRow(key);
  setTimeout(() => { if (/attached/.test(st.hint.textContent)) st.hint.textContent = ''; }, 6000);
}

/* ---------------------------------------------------------------- actions */
function logCmd(r) {
  $('#cmdlog').hidden = false;
  const line = el('div', 'cmdline');
  line.appendChild(Object.assign(el('div', 'c'), { textContent: '$ ' + r.cmd }));
  const out = (r.stdout || '').trim(); if (out) line.appendChild(Object.assign(el('div', 'o'), { textContent: out.slice(0, 1200) }));
  const err = (r.stderr || '').trim(); if (err) line.appendChild(Object.assign(el('div', r.ok ? 'o' : 'e'), { textContent: err.slice(0, 1200) }));
  $('#cmdlogBody').prepend(line);
}
async function act(action, id) {
  const r = await (await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, id }) })).json();
  logCmd(r); refresh();
}
async function refresh() {
  try {
    const d = await (await fetch('/api/agents')).json();
    FEED_SEQ = d.seq ?? null;          // a full list is also the way back in step
    applyAgents(d.agents);
    LAST_AGENTS_AT = Date.now();
  } catch {}
}
/* THE FEED IS A DIFFERENCE, and a difference is only meaningful against the
   base it was computed from. `FEED_SEQ` is that base; anything that does not
   follow it exactly is not merged, it is re-fetched. */
let FEED_SEQ = null;
function applyDelta(changed, gone) {
  const at = new Map(AGENTS.map((a, i) => [keyOf(a), i]));
  for (const a of changed) {
    const i = at.get(keyOf(a));
    if (i === undefined) { at.set(keyOf(a), AGENTS.length); AGENTS.push(a); }
    else AGENTS[i] = a;
  }
  if (gone?.length) { const g = new Set(gone); AGENTS = AGENTS.filter((a) => !g.has(keyOf(a))); }
  applyAgents(AGENTS);
}
function applyAgents(agents) {
  AGENTS = applyOverrides(agents);
  detectTransitions();
  scheduleList();
  // Only what is on the screen — the rest catches up when it scrolls in.
  for (const k of paneKeys()) if (!isCompose(k) && !isTerm(k) && paneSeen(k)) { updatePane(k); PD.get(termKey(k))?.paint?.(); }
}

/* --------------------------------------------------------------- terminal */
function openTerm(key, { focus = true } = {}) {
  const st = PD.get(key), a = findAgent(key);
  if (!st || !a?.id) return;
  if (st.ws?.readyState === 1) { if (focus) st.term.focus(); return; }
  /* ONE attach per pane. Insert used to call this on every click while the
     socket was still connecting, and each call built another xterm and another
     `claude attach` — that is where the same message landed two, three, four
     times. Connecting, or the rAF below still pending, means: already on it. */
  if (st.ws?.readyState === 0 || st.opening) { st.wantFocus ||= focus; return; }
  if (st.term) { try { st.term.dispose(); } catch {} st.term = null; st.ws = null; }   // dead socket: rebuild
  st.opening = true; st.wantFocus = focus; st.termUp = false; st.wsOpenAt = 0;
  st.termTitle.textContent = `claude attach ${a.id}`;
  st.term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    fontSize: 12, lineHeight: 1.15, cursorBlink: true, scrollback: 4000,
    theme: { background: '#050505', foreground: '#dcdcdc', cursor: colorOf(a), selectionBackground: '#333' },
  });
  st.fit = new FitAddon.FitAddon();
  st.term.loadAddon(st.fit); st.term.open(termHostOf(key));
  mountTerm(key);                       // shows the bottom strip only if docked
  requestAnimationFrame(() => {
    try { st.fit.fit(); } catch {}
    const { cols, rows } = st.term;
    st.ws = new WebSocket(`ws://${location.host}/pty?id=${encodeURIComponent(a.id)}&cols=${cols}&rows=${rows}`);
    st.opening = false;
    st.ws.binaryType = 'arraybuffer';
    st.ws.onopen = () => { st.wsOpenAt = Date.now(); };
    st.ws.onmessage = (ev) => {
      const s = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
      if (s.startsWith('{') && /"t":"(started|exit|fatal)"/.test(s)) {
        try {
          const j = JSON.parse(s);
          if (j.t === 'exit') st.term.write('\r\n\x1b[2m— detached. The session keeps running. —\x1b[0m\r\n');
          if (j.t === 'fatal') st.term.write('\r\n\x1b[31m' + j.msg + '\x1b[0m\r\n');
          if (j.t === 'started' && st.wantFocus) setTimeout(() => st.term.focus(), 60);
          return;
        } catch {}
      }
      /* READY = the prompt is drawn. Measured 2026-09-02 on a live agent: the
         socket opens in ~0.1 s, `claude attach` prints "Attaching…" (with
         bracketed-paste ON — so \x1b[?2004h is NOT the signal, it comes 3 s too
         early), and the real screen with its `❯` input box lands at 4.3–5.7 s.
         The old fixed 1.2 s wait pasted into "Attaching…", where the text was
         typed into nothing and silently lost — the "sent once, never arrived"
         case. The `❯` is drawn in every state (idle, working, a dialog's
         cursor), so it is the one thing that means "someone is listening". */
      if (!st.termUp && s.includes('❯')) st.termUp = true;
      st.term.write(s);
    };
    st.term.onData((d) => { if (st.ws?.readyState === 1) st.ws.send(d); });
    st.term.onResize(({ cols, rows }) => { if (st.ws?.readyState === 1) st.ws.send('\x00resize:' + cols + ',' + rows); });
  });
}
function closeTerm(key) {
  const st = PD.get(key); if (!st) return;
  // Emptying the host is what makes it GONE; tearing down 4000 lines of
  // scrollback is what makes it slow, and nobody is waiting for that.
  const ws = st.ws, term = st.term;
  st.ws = null; st.term = null;
  setTimeout(() => { try { ws?.close(); } catch {} try { term?.dispose(); } catch {} }, 0);
  st.termHost.textContent = '';
  const outHost = PD.get(termKey(key));
  if (outHost) { outHost.host.textContent = ''; outHost.empty.hidden = false; }
  st.termWrap.hidden = true;
  st.opening = false; st.termUp = false;
  disarm(key);   // there is no terminal left to press Enter in
}

/* THE ONE WAIT. Resolves true once the terminal is attached AND Claude Code's
   prompt is drawn (`❯` seen — see onmessage), false if the socket died. Every
   sender goes through here, and concurrent callers share the same promise —
   so the second click during the wait cannot start a second attach or a
   second paste. The fixed 1200 ms sleep that used to sit here was both too
   long on a warm attach and too short on a cold one. */
function ensureTerm(key, { focus = true } = {}) {
  const st = PD.get(key); if (!st || !findAgent(key)?.id) return Promise.resolve(false);
  if (st.ws?.readyState === 1 && st.termUp) return Promise.resolve(true);
  if (st.termWait) return st.termWait;
  openTerm(key, { focus });
  st.termWait = new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const open = st.ws?.readyState === 1;
      if (open && st.termUp) return resolve(true);
      // No `❯` seen (a split multi-byte chunk, a different CLI): measured to the
      // prompt was 4.3–8.7 s (`claude attach` itself is that slow under load),
      // so the blind fallback sits well past it — pasting early loses the text.
      if (open && Date.now() - (st.wsOpenAt || t0) > 15000) return resolve(true);
      if (st.ws && st.ws.readyState > 1) return resolve(false);                      // closed under us
      if (Date.now() - t0 > 25000) return resolve(open);
      setTimeout(tick, 40);
    };
    tick();
  }).finally(() => { st.termWait = null; });
  return st.termWait;
}

/* Two deliberate steps, both reachable with the mouse alone:
   Insert types the draft into the real terminal, then the same button becomes
   Send and presses Enter. It is still you confirming — you can see exactly
   where the text landed before the second click — but you never have to reach
   for the keyboard. Any edit disarms it, because the terminal would otherwise
   still hold the OLD text while the box shows the new one. */
/* A slash command IS the confirmation — you picked the value from a list, so
   there is nothing further to confirm. It goes through the same real terminal
   as everything else and is written to the command log, and the dropdown then
   re-reads the truth from the transcript. */
async function sendSessionCommand(key, cmd) {
  const st = PD.get(key), a = findAgent(key);
  if (!st || !a?.id) return;
  if (!(await ensureTerm(key))) { st.hint.textContent = 'No terminal — could not send.'; return; }
  st.ws.send('\x1b[200~' + cmd + '\x1b[201~');
  st.ws.send('\r');
  logCmd({ ok: true, cmd: `${cmd}   → ${a.id}`, stdout: '', stderr: '' });
  st.hint.textContent = `Sent ${cmd}`;
  setTimeout(() => { if (st.hint.textContent.startsWith('Sent /')) st.hint.textContent = ''; }, 5000);
}

function paintDraftBtn(key) {
  const st = PD.get(key); if (!st) return;
  const busy = !!st.sending;
  st.insertBtn.textContent = busy ? 'Opening…' : st.armed ? 'Send ↵' : 'Insert ⇧⌘↵';
  st.insertBtn.classList.toggle('armed', !!st.armed && !busy);
  st.insertBtn.disabled = busy;
  st.insertBtn.title = st.armed
    ? 'Presses Enter in the terminal — glance at it first to see the text landed where you expect'
    : 'Types it into the real terminal without pressing Enter';
  if (st.sendBtn) {
    st.sendBtn.textContent = busy ? 'Opening…' : 'Send ⌘↵';
    st.sendBtn.disabled = busy;
  }
}
function disarm(key) { const st = PD.get(key); if (st?.armed) { st.armed = false; paintDraftBtn(key); } }

/* ONE SEND AT A TIME, per pane. The attach takes a second or three, and the
   buttons kept accepting clicks for that whole time — each one another paste.
   Measured cost: the same prompt at an agent two, three, four times, each a
   full turn of tokens. While a send is in flight both buttons are disabled and
   say so; a click that still gets through (⌘↵ auto-repeat, a queued event) is
   dropped here, not queued. */
async function withSend(key, fn) {
  const st = PD.get(key); if (!st || st.sending) return;
  st.sending = true; paintDraftBtn(key);
  try { await fn(st); } finally { st.sending = false; paintDraftBtn(key); }
}

/* CR is Enter and would SUBMIT at every line break — a three-line draft used
   to fire off its first two lines as separate prompts. LF is what Claude
   Code's own Ctrl+J inserts: a newline inside the prompt.

   Wrapped as a BRACKETED PASTE (measured: Claude Code turns it on with
   \x1b[?2004h). A paste is handled as one block instead of as typing, so an
   "@" in a file reference cannot pop the file picker and swallow the rest. */
function pasteInto(st, text) {
  st.ws.send('\x1b[200~' + text.replace(/\r\n?/g, '\n') + '\x1b[201~');
}

/* Insert: type it in, do not press Enter. You look, then Send. */
function insertDraft(key) {
  return withSend(key, async (st) => {
    if (st.armed) return sendDraft(key);
    const text = st.draft.value;
    if (!text.trim()) return;
    if (!(await ensureTerm(key))) { st.hint.textContent = 'No terminal — could not insert.'; return; }
    pasteInto(st, text);
    st.term.focus();
    st.armed = true;
    st.hint.textContent = 'In the terminal. Click Send, or press Enter there.';
  });
}

/* Send now: attach if needed, wait for the prompt, paste, Enter — one click.
   The waiting has not gone away; it has moved to AFTER the click, where it
   cannot collect more clicks. */
function sendNow(key) {
  return withSend(key, async (st) => {
    if (st.armed) return sendDraft(key);            // the text is already in the terminal
    const text = st.draft.value;
    if (!text.trim()) return;
    st.hint.textContent = 'Opening the terminal…';
    if (!(await ensureTerm(key))) { st.hint.textContent = 'No terminal — not sent. Your text is still here.'; return; }
    // The draft could have been edited while we waited; send what is there NOW.
    const now = st.draft.value;
    if (!now.trim()) return;
    pasteInto(st, now);
    // Let the paste land as one block before Enter follows it on the same pipe.
    await new Promise((r) => setTimeout(r, 200));
    if (st.ws?.readyState !== 1) { st.hint.textContent = 'Terminal closed — not sent. Your text is still here.'; return; }
    finishSend(key);
  });
}

/* Enter, then the bookkeeping that every successful send shares. */
function finishSend(key) {
  const st = PD.get(key); if (!st) return;
  st.ws.send('\r');
  st.term.focus();
  // Clearing is safe: if that Enter hit a dialog instead, the text is still
  // sitting visible in the terminal input and nothing is lost.
  pushHistory(st, st.draft.value);
  st.draft.value = ''; setDraft(key, ''); autoGrow(st.draft);
  st.histIdx = null; st.histStash = null;
  st.armed = false; paintDraftBtn(key);
  st.hint.textContent = 'Sent.';
  patchRow(key);
  setTimeout(() => { if (st.hint.textContent === 'Sent.') st.hint.textContent = ''; }, 4000);
}

function sendDraft(key) {
  const st = PD.get(key); if (!st) return;
  if (st.ws?.readyState !== 1) { disarm(key); return; }
  finishSend(key);
}

/* ------------------------------------------------------------------ usage */
/* Usage. The old strip said "1.0M · 10% of 10M" — a raw token count and a
   percentage of a number nobody recognises. This answers the question you
   actually have: am I ahead of my own pace for this week? */
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + ' million' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' thousand' : String(n);
let USAGE = null;

async function loadUsage() {
  try { USAGE = await (await fetch('/api/usage')).json(); } catch { return; }
  const u = USAGE;
  const used = Math.round(u.weekUsedFrac * 100);
  const gone = Math.round(u.weekElapsedFrac * 100);
  const lead = used - gone;

  const wrap = $('#usage'); wrap.textContent = '';
  const bar = el('div', 'ubar' + (lead > 10 ? ' over' : ''));
  const fill = el('div', 'ufill'); fill.style.width = Math.min(100, used) + '%';
  const mark = el('div', 'umark'); mark.style.left = Math.min(100, gone) + '%';
  mark.title = 'how far into the week you are';
  bar.append(fill, mark);

  wrap.append(
    el('span', 'ulabel', 'week'),
    el('b', null, used + '%'),
    bar,
    el('span', 'upct' + (lead > 10 ? ' over' : ''), `${gone}% elapsed`),
  );
  wrap.title = 'Click for details';
  wrap.onclick = toggleUsagePanel;
}

function toggleUsagePanel() {
  const old = $('#usagepanel');
  if (old) { old.remove(); return; }
  const u = USAGE; if (!u) return;
  const used = Math.round(u.weekUsedFrac * 100), gone = Math.round(u.weekElapsedFrac * 100);
  const lead = used - gone;

  const p = el('div', 'usagepanel'); p.id = 'usagepanel';
  const row = (k, v, cls) => { const r = el('div', 'urow'); r.append(el('span', 'uk', k), el('span', 'uv ' + (cls || ''), v)); p.appendChild(r); };

  p.appendChild(el('h4', null, 'This week'));
  row('Spent so far', `${used}% of a typical week`);
  row('Week elapsed', `${gone}%`);
  row('Pace', lead > 0 ? `${lead} points ahead` : `${-lead} points behind`, lead > 10 ? 'warn' : lead > 0 ? '' : 'good');

  p.appendChild(el('h4', null, 'Today'));
  row('Spent today', `${u.todayVsTypical.toFixed(2)}× a typical day`);
  row('Output tokens', tok(u.today));

  p.appendChild(el('h4', null, 'Your baseline'));
  row('Typical day', tok(u.avgDay));
  row('Typical week', tok(u.typicalWeek));
  row('Measured over', `${u.activeDays} active days of the last 28`);

  const chart = el('div', 'ubars');
  const max = Math.max(1, ...u.days.map((d) => d.out));
  for (const d of u.days) {
    const c = el('div', 'ubcol'); c.title = `${d.day}: ${tok(d.out)} output tokens`;
    const s = el('div', 'ub'); s.style.height = Math.max(2, Math.round((d.out / max) * 46)) + 'px';
    c.append(s, el('span', 'ubd', d.day.slice(8)));
    chart.appendChild(c);
  }
  p.append(el('h4', null, 'Last 14 days'), chart);

  p.appendChild(Object.assign(el('p', 'unote'), {
    textContent: 'Counted from your own transcripts. Anthropic’s real limit is not readable from this machine — there is no `claude usage` command and no quota file — so these percentages compare you against your own average, not against your plan.',
  }));
  document.body.appendChild(p);
  const r = $('#usage').getBoundingClientRect();
  p.style.top = (r.bottom + 8) + 'px';
  p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!p.contains(e.target) && !$('#usage').contains(e.target)) { p.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

/* ------------------------------------------------------------------ memory */
/* RAM. "How much is used" is the wrong question on a Mac — it reads nearly full
   all day, because macOS fills whatever it has. The question is how much is
   WANTED, by what KIND of thing, and how far past the RAM that is: everything
   right of the white line lives compressed or on disk, and that is the lag.
   So the bar is demand, the line is the RAM you have, and the agents that are
   finished but still sitting on it are listed with the minute they give it back. */
let MEM = null;
let memTimer = null;
const GIB = 1024 ** 3;
const gbN = (b) => { const g = (b || 0) / GIB; return g >= 9.95 ? g.toFixed(0) : g.toFixed(1); };
const gbT = (b) => gbN(b) + ' GB';
const mbT = (b) => (b >= GIB ? gbT(b) : Math.round((b || 0) / 1024 ** 2) + ' MB');
const minT = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const PRESSURE = {
  1: { cls: 'good', icon: '✓', text: 'normal' },
  2: { cls: 'warn', icon: '▲', text: 'high — compressing and swapping' },
  4: { cls: 'crit', icon: '●', text: 'critical — swapping hard' },
};
const MEM_WHAT = {
  agents: 'The claude processes themselves, about 300 MB each. Finished agents count until they are stopped.',
  tools: 'What agents started: shells, test runs, MCP servers, dev servers, screenshot browsers.',
  chrome: 'Your browser. Every tab and extension is its own process.',
  cursor: 'The editor with its extensions and language servers.',
  other: 'Everything else that is open.',
  system: 'macOS itself: WindowServer, indexing, system services.',
};

async function loadMemory(procs) {
  let r;
  try { r = await (await fetch('/api/memory' + (procs ? '?procs=1' : ''))).json(); } catch { return; }
  MEM = { ...MEM, ...r };          // the strip's cheap answer must not erase the panel's
  paintMemStrip();
  if ($('#mempanel')) paintMemPanel();
}

function paintMemStrip() {
  const s = MEM?.sys, wrap = $('#mem');
  if (!s || !wrap) return;
  const tight = s.pressure >= 2;
  wrap.textContent = '';
  const bar = el('div', 'ubar' + (tight ? ' over' : ''));
  const fill = el('div', 'ufill'); fill.style.width = Math.min(100, (s.used / s.total) * 100) + '%';
  bar.appendChild(fill);
  wrap.append(el('span', 'ulabel', 'ram'), el('b', null, `${gbN(s.used)}/${gbN(s.total)} GB`), bar);
  if (s.swapUsed >= 0.5 * GIB) wrap.appendChild(el('span', 'upct' + (tight ? ' over' : ''), `+${gbT(s.swapUsed)} swap`));
  wrap.title = `${gbT(s.used)} of ${gbT(s.total)} in use, ${gbT(s.swapUsed)} swapped to disk, pressure ${(PRESSURE[s.pressure] || {}).text || 'unknown'}. Click for what is using it.`;
  wrap.onclick = toggleMemPanel;
}

async function setAutoStop(patch) {
  try {
    const r = await (await fetch('/api/autostop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })).json();
    if (MEM?.autoStop && r.autoStop) Object.assign(MEM.autoStop, r.autoStop);
    return r;
  } catch { return null; }
}

function toggleMemPanel() {
  const old = $('#mempanel');
  if (old) { old.remove(); clearInterval(memTimer); memTimer = null; return; }
  const p = el('div', 'usagepanel mempanel'); p.id = 'mempanel';
  const data = el('div'); data.id = 'memdata';

  // Built once, only their values are refreshed: re-creating a <select> every
  // five seconds would snap it shut in your hand.
  const ctl = el('div', 'memctl');
  const line = el('label', 'memrow');
  const sel = el('select', 'memsel'); sel.id = 'memsel';
  for (const [v, t] of [[0, 'never'], [30, '30 min'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours']]) {
    const o = el('option', null, t); o.value = String(v); sel.appendChild(o);
  }
  sel.onchange = async () => { await setAutoStop({ min: Number(sel.value) }); loadMemory(true); };
  line.append(el('span', 'uk', 'Stop finished agents after'), sel);
  const wl = el('label', 'memrow memchk');
  const cb = el('input'); cb.type = 'checkbox'; cb.id = 'memwait';
  cb.onchange = async () => { await setAutoStop({ waiting: cb.checked }); loadMemory(true); };
  wl.append(cb, el('span', 'uk', 'Also agents that wait on your answer'));
  const btn = el('button', 'btn small'); btn.id = 'memnow';
  btn.onclick = async () => {
    const n = Number(btn.dataset.n || 0);
    if (!n || !confirm(`Stop ${n} finished agent${n > 1 ? 's' : ''} now? Their conversations are kept, Reply resumes them.`)) return;
    btn.disabled = true; btn.textContent = 'Stopping…';
    await setAutoStop({ now: true });
    loadMemory(true);
  };
  const today = el('div', 'memtoday'); today.id = 'memtoday';
  ctl.append(el('h4', null, 'Auto-stop'), line, wl, btn, today, Object.assign(el('p', 'unote'), {
    textContent: 'A stopped agent keeps its whole conversation and Reply resumes it where it was. After an hour idle its prompt cache has expired anyway, so resuming costs no extra tokens. Never stopped: agents that are working, have shells or subagents running, are pinned, or are open in a terminal.',
  }));

  p.append(data, ctl);
  document.body.appendChild(p);
  const r = $('#mem').getBoundingClientRect();
  p.style.top = (r.bottom + 8) + 'px';
  p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  paintMemPanel();
  loadMemory(true);
  memTimer = setInterval(() => { if (!document.hidden) loadMemory(true); }, 5000);
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!p.isConnected) { document.removeEventListener('pointerdown', off); return; }
    if (!p.contains(e.target) && !$('#mem').contains(e.target)) {
      p.remove(); clearInterval(memTimer); memTimer = null;
      document.removeEventListener('pointerdown', off);
    }
  }), 0);
}

function paintMemPanel() {
  const data = $('#memdata'); if (!data) return;
  hideMemTip();
  const s = MEM?.sys, pr = MEM?.procs, as = MEM?.autoStop;
  data.textContent = '';
  if (!s) { data.appendChild(el('div', 'memloading', 'Reading memory…')); return; }

  // ---- headline: demand against the RAM there is ----
  const head = el('div', 'memhead');
  if (pr) {
    const over = pr.total - s.total;
    head.append(el('div', 'big', gbT(pr.total)), el('div', 'sub', over > 0
      ? `wanted by all programs, ${gbT(over)} more than the ${gbT(s.total)} this Mac has`
      : `wanted by all programs, of ${gbT(s.total)}`));
  } else {
    head.append(el('div', 'big', gbT(s.used)), el('div', 'sub', `in use of ${gbT(s.total)} · measuring what uses it (a few seconds on a busy Mac)`));
  }
  data.appendChild(head);
  if (pr) data.appendChild(memStack(pr, s));

  // ---- the machine's own verdict ----
  data.appendChild(el('h4', null, 'The Mac right now'));
  const row = (k, v, cls, title) => {
    const r = el('div', 'urow'); if (title) r.title = title;
    r.append(el('span', 'uk', k), typeof v === 'string' ? el('span', 'uv ' + (cls || ''), v) : v);
    data.appendChild(r);
  };
  const pz = PRESSURE[s.pressure] || { cls: '', icon: '?', text: 'unknown' };
  const pv = el('span', 'uv memst');
  pv.append(el('span', 'memst-ic ' + pz.cls, pz.icon), document.createTextNode(pz.text));
  row('Memory pressure', pv, null, 'macOS\'s own verdict (kern.memorystatus_vm_pressure_level), not a threshold of ours.');
  row('In RAM', `${gbT(s.used)} of ${gbT(s.total)}`, null,
    `apps ${gbT(s.app)} · compressed ${gbT(s.compressed)} · macOS ${gbT(s.wired)} · file cache ${gbT(s.cached)}`);
  if (s.squeezed > 0) row('Compressed', `${gbT(s.squeezed)} squeezed into ${gbT(s.compressed)}`, null,
    'Pages macOS packed to make room. Unpacking them costs CPU every time they are touched.');
  row('Swapped to disk', `${gbT(s.swapUsed)} of ${gbT(s.swapTotal)}`, s.swapUsed > s.swapTotal * 0.5 ? 'warn' : '');

  // ---- agents, and when each one gives its RAM back ----
  if (as) {
    const now = Date.now();
    const rows = as.rows.slice().sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
    const idle = rows.filter((x) => !x.hold);
    const idleBytes = idle.reduce((sum, x) => sum + (x.bytes || 0), 0);
    data.appendChild(el('h4', null, `Agents in memory · ${rows.length}`));
    if (idle.length) {
      data.appendChild(el('div', 'memidle', `${idle.length} finished and idle${idleBytes ? `, holding ${gbT(idleBytes)}` : ''}`));
    }
    const list = el('div', 'memagents');
    const SHOW = 12;
    for (const x of rows.slice(0, SHOW)) {
      const r = el('div', 'memagent' + (x.hold ? '' : ' idle'));
      const when = x.hold
        ? x.hold
        : !as.min ? 'finished · auto-stop off'
        : x.stopAt <= now ? 'stops at the next check'
        : `stops in ${minT(x.stopAt - now)}`;
      const nm = el('span', 'mem-name', x.name);
      nm.title = `${x.name}${x.id ? ' · #' + x.id : ''}${x.idleSince ? ` · last activity ${ago(x.idleSince)} ago` : ''}`;
      r.append(nm, el('span', 'mem-when', when), el('span', 'mem-size', x.bytes == null ? '…' : mbT(x.bytes)));
      list.appendChild(r);
    }
    if (rows.length > SHOW) list.appendChild(el('div', 'memmore', `+${rows.length - SHOW} more`));
    data.appendChild(list);

    // controls: values only
    const sel = $('#memsel'), cb = $('#memwait'), btn = $('#memnow'), today = $('#memtoday');
    if (sel && document.activeElement !== sel) {
      if (![...sel.options].some((o) => Number(o.value) === as.min)) {
        const o = el('option', null, `${as.min} min`); o.value = String(as.min); sel.appendChild(o);
      }
      sel.value = String(as.min);
    }
    if (cb) cb.checked = Boolean(as.waiting);
    if (btn) {
      btn.dataset.n = String(idle.length);
      btn.disabled = idle.length === 0;
      btn.textContent = idle.length ? `Stop ${idle.length} now${idleBytes ? ' · ' + gbT(idleBytes) : ''}` : 'Nothing finished to stop';
    }
    if (today) {
      const t = as.today || {};
      today.textContent = t.count ? `Stopped today: ${t.count} agent${t.count > 1 ? 's' : ''}${t.bytes ? `, about ${gbT(t.bytes)} back` : ''}` : 'Nothing stopped today yet';
    }
  }
  if (pr) {
    const age = Math.round((Date.now() - pr.at) / 1000);
    data.appendChild(el('div', 'memfoot', `Per-program numbers are ${age < 5 ? 'fresh' : age + 's old'}${pr.footprint ? '' : ' · the per-process scan (top) failed, showing resident size instead (too low under pressure)'}`));
  }
}

function memStack(pr, s) {
  const wrap = el('div', 'memchart');
  const scale = Math.max(pr.total, s.total) || 1;
  const track = el('div', 'memtrack');
  const bar = el('div', 'memstack');
  bar.style.width = (pr.total / scale) * 100 + '%';
  for (const g of pr.groups) {
    if (g.bytes <= 0) continue;
    const seg = el('div', 'memseg');
    seg.style.flex = `${g.bytes} 1 0`;
    seg.style.background = `var(--mem-${g.id})`;
    seg.onpointerenter = () => showMemTip(seg, g, pr.total);
    seg.onpointerleave = hideMemTip;
    bar.appendChild(seg);
  }
  const line = el('div', 'memline'); line.style.left = (s.total / scale) * 100 + '%';
  line.appendChild(el('span', 'memline-label', `${gbN(s.total)} GB RAM`));
  track.append(bar, line);
  wrap.appendChild(track);
  if (pr.total > s.total) wrap.appendChild(el('div', 'memover', 'right of the line: compressed or on disk'));

  // The legend is the table: every value is here, the bar only shows the shape.
  const leg = el('div', 'memlegend');
  for (const g of pr.groups) {
    const r = el('div', 'memleg');
    const sw = el('span', 'memsw'); sw.style.background = `var(--mem-${g.id})`;
    r.append(sw, el('span', 'uk', g.label), el('span', 'uv', gbT(g.bytes)));
    r.onpointerenter = () => showMemTip(r, g, pr.total);
    r.onpointerleave = hideMemTip;
    leg.appendChild(r);
  }
  wrap.appendChild(leg);
  return wrap;
}

function showMemTip(anchor, g, total) {
  const p = $('#mempanel'); if (!p) return;
  let tip = $('#memtip');
  if (!tip) { tip = el('div', 'memtip'); tip.id = 'memtip'; p.appendChild(tip); }
  tip.textContent = '';
  tip.append(el('div', 'memtip-h', `${g.label} · ${gbT(g.bytes)} · ${Math.round((g.bytes / total) * 100)}%`));
  for (const t of g.top) {
    const r = el('div', 'urow'); r.append(el('span', 'uk', t.name), el('span', 'uv', mbT(t.bytes)));
    tip.appendChild(r);
  }
  tip.append(el('div', 'memtip-s', `${g.procs} processes. ${MEM_WHAT[g.id] || ''}`));
  const pb = p.getBoundingClientRect(), ab = anchor.getBoundingClientRect();
  tip.style.top = (ab.bottom - pb.top + p.scrollTop + 6) + 'px';
  tip.style.left = Math.max(8, Math.min(pb.width - 268, ab.left - pb.left)) + 'px';
  tip.hidden = false;
}
function hideMemTip() { const t = $('#memtip'); if (t) t.hidden = true; }

/* ---------------------------------------------------------------- context */
/* The context budget. Two costs that get confused constantly:

   BASELINE — what every session of a project pays before it reads a line of
              code (CLAUDE.md + its @-imports + the memory index). Knowable
              exactly, and the one that creeps: a paragraph a day, invisible,
              charged to every agent forever.

   LIVE     — what a running session is carrying right now, taken from the last
              message's usage. Not an estimate; it is what the API was billed.

   The light is on the BASELINE, judged by absolute size and by growth — not by
   percent of window. With a 1M window a 29k baseline is 3% and would glow green
   forever while still costing 29k on every session of every agent. */
let CTX = null;

const ctxTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);

async function loadContext() {
  try { CTX = await (await fetch('/api/context')).json(); } catch { return; }
  const s = CTX.summary || {};
  const wrap = $('#ctx'); if (!wrap) return;
  wrap.textContent = '';
  wrap.append(
    el('span', 'ctx-lamp ' + (s.worstLight || 'green')),
    el('span', null, 'context'),
    el('b', null, ctxTok(s.worstTok || 0)),
  );
  wrap.title = s.worstProject
    ? `${s.worstProject}: ${(s.worstTok || 0).toLocaleString()} tokens loaded into every session — click for the breakdown`
    : 'Click for the breakdown';
  wrap.onclick = toggleCtxPanel;
  if ($('#ctxpanel')) { $('#ctxpanel').remove(); toggleCtxPanel(); }
  // Deep link: /#context opens the panel straight away. Also what makes the
  // panel reachable in a headless check, where nobody can click.
  if (location.hash === '#context' && !$('#ctxpanel')) toggleCtxPanel();
}

function lamp(cls) { const n = el('span', 'lamp'); n.style.background = `var(--${cls === 'red' ? 'stop' : cls === 'amber' ? 'wait' : 'go'})`; return n; }

function toggleCtxPanel() {
  const old = $('#ctxpanel');
  if (old) { old.remove(); return; }
  const c = CTX; if (!c) return;
  const s = c.summary || {};

  const p = el('div', 'ctxpanel'); p.id = 'ctxpanel';

  // ---- headline: the worst offender, big ----
  const head = el('div', 'ctxhead');
  head.append(lamp(s.worstLight));
  const hb = el('div');
  hb.append(
    el('div', 'big', `${ctxTok(s.worstTok || 0)} tokens`),
    el('div', 'sub', s.worstProject
      ? `loaded into every ${s.worstProject} session, before any work`
      : 'no project measured yet'),
  );
  head.appendChild(hb);
  p.appendChild(head);

  // ---- per project ----
  p.appendChild(el('h4', null, 'Baseline per project'));
  for (const pr of c.projects) {
    const r = el('div', 'ctxrow');
    r.appendChild(lamp(pr.light));
    r.appendChild(el('span', 'nm', pr.name));
    r.appendChild(el('span', 'tk', ctxTok(pr.baselineTok)));
    const g = pr.growWeek;
    const d = el('span', 'dl ' + (g == null ? 'flat' : g > 0.02 ? 'up' : g < -0.02 ? 'down' : 'flat'),
      g == null ? '—' : (g > 0 ? '+' : '') + Math.round(g * 100) + '% 7d');
    d.title = pr.weekAgo ? `was ${pr.weekAgo.toLocaleString()} tokens a week ago` : 'no earlier sample yet — the trend starts today';
    r.appendChild(d);
    r.style.cursor = 'pointer';
    r.onclick = () => { p.remove(); showCtxProject(pr); };
    p.appendChild(r);
  }

  // ---- concurrency: what many agents actually costs ----
  if (s.liveAgents > 0) {
    p.appendChild(el('h4', null, 'Right now'));
    const row = (k, v) => { const r = el('div', 'urow'); r.append(el('span', 'uk', k), el('span', 'uv', v)); p.appendChild(r); };
    row('Live agents', String(s.liveAgents));
    row('Boilerplate in flight', ctxTok(s.boilerplate) + ' tokens');
    if (s.liveAgents > 1) {
      p.appendChild(Object.assign(el('div', 'ctxwarn'), {
        textContent: `Every agent pays its repo's baseline in full — the files are re-sent per session, never shared between them. `
          + `${s.liveAgents} agents currently carry ${ctxTok(s.boilerplate)} tokens of identical text.`,
      }));
    }
  }

  // ---- dev servers: the other multi-agent waste ----
  const srv = c.servers || [];
  if (srv.length) {
    p.appendChild(el('h4', null, 'Dev servers listening'));
    const line = el('div', 'ctxfile');
    line.appendChild(Object.assign(el('span', 'fn'), { textContent: srv.map((x) => x.port).join(' · ') }));
    line.appendChild(el('span', 'fb', String(srv.length)));
    p.appendChild(line);
    const dupes = srv.filter((x) => x.pids.length > 1);
    p.appendChild(Object.assign(el('p', 'ctxnote'), {
      textContent: dupes.length
        ? `${dupes.length} port(s) served by more than one process — likely orphans from earlier agents.`
        : 'These cost CPU and RAM, not tokens. One shared server per repo is the cheap setup; a pile of orphans is the expensive one.',
    }));
  }

  p.appendChild(Object.assign(el('p', 'ctxnote'), {
    textContent: 'Baseline is measured from disk (CLAUDE.md, its @-imports, the memory index) at ~4 bytes per token. '
      + 'Window size is not readable from this machine, so it is taken from the largest context each model has actually reached in your own transcripts.',
  }));

  document.body.appendChild(p);
  const r = $('#ctx').getBoundingClientRect();
  p.style.top = (r.bottom + 8) + 'px';
  p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!p.contains(e.target) && !$('#ctx').contains(e.target)) { p.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

/** Drill-down: WHICH file is the bloat, and what the live sessions carry. */
function showCtxProject(pr) {
  const p = el('div', 'ctxpanel'); p.id = 'ctxpanel';

  const head = el('div', 'ctxhead');
  head.append(lamp(pr.light));
  const hb = el('div');
  hb.append(el('div', 'big', `${ctxTok(pr.baselineTok)} tokens`), el('div', 'sub', pr.name + ' — every session'));
  head.appendChild(hb);
  p.appendChild(head);

  // history sparkline — the creep, made visible
  if (pr.history && pr.history.length > 1) {
    p.appendChild(el('h4', null, `Baseline over ${pr.history.length} days`));
    const max = Math.max(...pr.history.map(([, v]) => v)) || 1;
    const sp = el('div', 'ctxspark');
    pr.history.forEach(([day, v], i) => {
      const b = el('span', i === pr.history.length - 1 ? 'last' : null);
      b.style.height = Math.max(2, Math.round((v / max) * 26)) + 'px';
      b.title = `${day}: ${v.toLocaleString()} tokens`;
      sp.appendChild(b);
    });
    p.appendChild(sp);
  }

  p.appendChild(el('h4', null, 'What is in it'));
  const max = pr.files[0]?.bytes || 1;
  for (const f of pr.files) {
    const row = el('div', 'ctxfile');
    const bar = el('span', 'bar'); bar.style.width = Math.max(2, Math.round((f.bytes / max) * 70)) + 'px';
    row.append(bar,
      el('span', 'fn', f.path.split('/').pop()),
      el('span', 'fw', f.why),
      el('span', 'fb', ctxTok(Math.round(f.bytes / 4))));
    row.title = f.path;
    p.appendChild(row);
  }

  const live = (pr.sessions || []).filter((s) => s.live);
  if (live.length) {
    p.appendChild(el('h4', null, 'Live sessions — real fill'));
    for (const s of live) {
      const row = el('div', 'ctxsess');
      const track = el('div', 'track');
      const fill = el('div', 'fill' + (s.frac > 0.8 ? ' red' : s.frac > 0.5 ? ' amber' : ''));
      fill.style.width = Math.min(100, Math.round(s.frac * 100)) + '%';
      track.appendChild(fill);
      row.append(track, el('span', 'pc', `${ctxTok(s.ctx)} / ${ctxTok(s.window)}`));
      row.title = `${s.model} — ${s.ctx.toLocaleString()} tokens`;
      p.appendChild(row);
    }
  }

  const back = el('button', 'btn ghost small', '← all projects');
  back.style.marginTop = '12px';
  back.onclick = () => { p.remove(); toggleCtxPanel(); };
  p.appendChild(back);

  document.body.appendChild(p);
  const r = $('#ctx').getBoundingClientRect();
  p.style.top = (r.bottom + 8) + 'px';
  p.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
  setTimeout(() => document.addEventListener('pointerdown', function off(e) {
    if (!p.contains(e.target) && !$('#ctx').contains(e.target)) { p.remove(); document.removeEventListener('pointerdown', off); }
  }), 0);
}

/* ------------------------------------------------------------------- boot */
/* THE LIVE CHAIN, and why it needs three belts.

   Measured: after the server restarted, the EventSource sat at readyState 2
   (CLOSED) and never came back — the page was frozen until a manual reload,
   which is exactly what "sometimes it only updates after I reload" is. The old
   `onerror` handler dimmed a dot and did nothing else.

   So: (1) reconnect on error, with backoff; (2) a HEARTBEAT, because silence is
   ambiguous — the agents payload is only sent when it CHANGES, so "quiet" is
   normal and only a missing ping proves the stream is dead; (3) a poll that
   runs whenever the stream is not demonstrably healthy, so no single mechanism
   is load-bearing on its own. */
let SSE = null, sseTimer = null, sseBackoff = 1000;
let LAST_STREAM_AT = 0;   // any traffic at all (ping or agents)
let LAST_AGENTS_AT = 0;   // a real payload

const markConn = (ok) => $('#conn').classList.toggle('on', ok);

function connectSSE() {
  try { SSE?.close(); } catch {}
  // the workspace rides along: it is how the server knows which ones have a window open
  SSE = new EventSource('/api/events?ws=' + encodeURIComponent(WS));
  SSE.onopen = () => { sseBackoff = 1000; LAST_STREAM_AT = Date.now(); markConn(true); };
  SSE.addEventListener('layout', (e) => { try { adoptLayout(JSON.parse(e.data)); } catch {} });
  SSE.addEventListener('wsinfo', (e) => {
    try {
      const m = JSON.parse(e.data);
      if (m.name === WS) { setWsInfo(m.ws); renderList(); updateAmbient(); }
    } catch {}
  });
  SSE.onerror = () => { markConn(false); reconnectSoon(); };
  SSE.addEventListener('ping', () => { LAST_STREAM_AT = Date.now(); markConn(true); });
  SSE.addEventListener('agents', (e) => {
    LAST_STREAM_AT = LAST_AGENTS_AT = Date.now();
    markConn(true);
    // The sequence number rides in the SSE `id:` field, so the body stays the
    // plain array it has always been.
    FEED_SEQ = Number(e.lastEventId) || null;
    applyAgents(JSON.parse(e.data));
  });
  SSE.addEventListener('agents-delta', (e) => {
    LAST_STREAM_AT = LAST_AGENTS_AT = Date.now();
    markConn(true);
    const seq = Number(e.lastEventId) || 0;
    // Out of step: do not guess. A full list costs one request; a wrongly
    // merged one shows agents that are not there any more.
    if (!FEED_SEQ || seq !== FEED_SEQ + 1) { refresh(); return; }
    FEED_SEQ = seq;
    const d = JSON.parse(e.data);
    applyDelta(d.changed || [], d.gone || []);
  });
}

function reconnectSoon() {
  if (sseTimer) return;
  sseTimer = setTimeout(() => { sseTimer = null; connectSSE(); }, sseBackoff);
  sseBackoff = Math.min(15000, Math.round(sseBackoff * 1.8));
}

/* The watchdog. `readyState !== OPEN` catches the measured freeze; the silent
   heartbeat catches the case a proxy holds a socket open that carries nothing.
   Both then do the same two things — poll once so the screen is right NOW, and
   rebuild the stream so it stays right. */
setInterval(() => {
  /* `hidden` used to mean "nobody is looking". With the floating window open
     that is no longer true — the tab is buried on another monitor while the
     numbers are being read. Parking here would freeze them at whatever they
     were when you looked away, and a confident wrong number is the one failure
     this window must not have. */
  if (document.hidden && !pipOpen()) return;
  const dead = Date.now() - LAST_STREAM_AT > 45000;
  if (SSE && SSE.readyState === 1 && !dead) return;
  markConn(false);
  refresh();
  reconnectSoon();
}, 4000);

/* Coming back to the tab must be instant, not "instant in up to four seconds".
   The tail loop parks itself while hidden, so without this the first thing you
   see after switching back is the state you left. */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  refresh();
  for (const k of paneKeys()) if (!isCompose(k) && !isTerm(k) && paneSeen(k)) tailPane(k);
  loadUsage();
  loadContext();
  if (!SSE || SSE.readyState !== 1) connectSSE();
});

setInterval(() => {
  TICK++;
  /* WRITE ONLY WHAT CHANGED. Every sidebar row carries an age now, so this is
     400 nodes a second — and assigning the same string still dirties layout,
     which means re-laying out the whole list once a second for a number that
     reads "14m" either way. Comparing first is free; writing is not. */
  const say = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  for (const node of document.querySelectorAll('[data-live]')) {
    const a = findAgent(node.dataset.live);
    if (a) say(node, activityText(a));
  }
  // "Finished · 12s ago" and friends: a timestamp on the node, text from the clock
  for (const node of document.querySelectorAll('[data-ago]')) {
    const at = Number(node.dataset.ago);
    if (at) say(node, (node.dataset.agoPrefix || '') + ago(at) + (node.dataset.agoSuffix || ''));
  }
  /* Claude Code writes an assistant message to the transcript only when that
     message is COMPLETE. While a long answer is still being written it exists
     in the live session and nowhere on disk — so a read-only view cannot show
     it, and the conversation looks like it stopped at the last tool call. Say
     so rather than let the gap look like a bug. */
  for (const node of document.querySelectorAll('[data-foothint]')) {
    const key = node.dataset.foothint;
    const st = PD.get(key);
    const gap = st?.lastEventTs ? (Date.now() - st.lastEventTs) / 1000 : 0;
    node.textContent = gap > 25 ? 'writing — appears when finished' : 'still working';
    node.classList.toggle('waiting', gap > 25);
  }
}, 1000);

/* The conversation tails on its own clock — measured, the agents payload only
   changes every few seconds because agents work in bursts. */
setInterval(() => {
  if (document.hidden) return;
  // Every open conversation, not only the ones the feed calls "working". A quiet
  // pane was not dead before — `updatePane` tails it on every agents payload —
  // but that made its liveness BORROWED from the feed, which is the one thing
  // that can freeze. Measured over 22s: 17 tails for "working" against 6 for
  // "done"/"idle"; now 15/15/15, on this loop's own clock. The request is a
  // byte-offset delta, so a conversation that did not move costs one empty
  // answer.
  for (const k of paneKeys()) {
    if (isCompose(k) || isTerm(k) || !paneSeen(k)) continue;
    if (findAgent(k)) tailPane(k);
  }
}, 2000);

setInterval(loadUsage, 60000);
// The strip costs ~20 ms on the server (vm_stat + sysctl); the panel keeps its own faster clock.
setInterval(() => { if (!document.hidden && !memTimer) loadMemory(false); }, 15000);
// Slower than usage on purpose: the baseline moves when someone edits a doc,
// not every minute, and the route walks every project's transcripts.
setInterval(loadContext, 90000);


/* ------------------------------------------------------------------- push */
/* The phone panel. Everything in here lives on the SERVER, not in this tab:
   the whole point of a push is that it goes out while no window is open, so a
   setting that only exists in a browser would be a setting that is off exactly
   when it matters. This form reads and writes /api/push, nothing else. */
function openPush() {
  const back = el('div', 'modal');
  const sheet = el('div', 'sheet');
  back.appendChild(sheet);
  const close = () => back.remove();
  back.onclick = (e) => { if (e.target === back) close(); };

  sheet.appendChild(el('h3', null, 'Push to phone'));
  const sub = el('p', 'muted');
  sub.textContent = 'ntfy: this machine calls out, no port is opened. The topic is the password — whoever knows it reads your notifications.';
  sheet.appendChild(sub);

  const state = el('p', 'muted', 'loading…');
  sheet.appendChild(state);

  const field = (label, node) => { const l = el('label', null, label); l.appendChild(node); sheet.appendChild(l); return node; };
  const inp = (v = '', ph = '') => { const n = el('input'); n.type = 'text'; n.value = v; n.placeholder = ph; n.autocomplete = 'off'; n.spellcheck = false; return n; };
  const chk = (label, on) => {
    const l = el('label', 'chk'); const n = el('input'); n.type = 'checkbox'; n.checked = on;
    l.append(n, document.createTextNode(' ' + label)); return { l, n };
  };

  const server = field('ntfy server', inp('', 'https://ntfy.sh'));
  const topic = field('Topic (= your password)', inp('', 'flotilla-…'));
  const token = field('Access token — needed if the topic is reserved', inp('', 'tk_… (optional)'));

  const boxes = el('div', 'pushboxes');
  const on = chk('Push on', false);
  const cDone = chk('done', true), cFail = chk('failed', true), cNeeds = chk('needs you', true);
  const detail = chk('include the last line (content leaves this machine)', false);
  const replies = chk('reply from the phone (writes into your agents!)', false);
  boxes.append(on.l, cDone.l, cFail.l, cNeeds.l, detail.l, replies.l);
  sheet.appendChild(boxes);

  const hint = el('p', 'muted');
  hint.textContent = 'Replies: write in the ntfy topic. "#<id> text" goes to that agent, plain text to the one reported last.';
  sheet.appendChild(hint);

  const foot = el('div', 'sheetfoot');
  const msg = el('span', 'muted'); msg.style.marginRight = 'auto';
  const bNew = el('button', 'btn ghost small', 'Random topic');
  const bTest = el('button', 'btn ghost small', 'Test push');
  const bSave = el('button', 'btn primary', 'Save');
  const bClose = el('button', 'btn ghost small', 'Close');
  foot.append(msg, bNew, bTest, bSave, bClose);
  sheet.appendChild(foot);
  bClose.onclick = close;

  const paint = (s) => {
    server.value = s.server || 'https://ntfy.sh';
    topic.value = s.topic || '';
    token.placeholder = s.hasToken ? '•••••• (saved — leave empty to keep)' : 'tk_… (optional)';
    on.n.checked = s.enabled; detail.n.checked = s.detail; replies.n.checked = s.replies;
    cDone.n.checked = s.lanes.done; cFail.n.checked = s.lanes.failed; cNeeds.n.checked = s.lanes.needs;
    /* The one line that answers "is it actually listening?". A form that only
       shows what you typed cannot tell you that the topic is wrong. */
    state.textContent = 'Status: ' + (!s.enabled ? 'off'
      : s.replies ? (s.subscribed ? 'on · listening for replies' : 'on · reply channel disconnected: ' + (s.lastError || '…'))
      : 'on · outbound only');
  };
  const put = async (body) => {
    const r = await fetch('/api/push', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return r.json();
  };

  bNew.onclick = async () => { topic.value = (await put({ suggest: true })).topic; msg.textContent = 'not saved yet'; };
  bTest.onclick = async () => {
    const r = await put({ test: true });
    msg.textContent = r.ok ? 'Test sent.' : 'Error: ' + (r.error || '?');
  };
  bSave.onclick = async () => {
    const body = {
      enabled: on.n.checked, server: server.value, topic: topic.value,
      replies: replies.n.checked, detail: detail.n.checked,
      lanes: { done: cDone.n.checked, failed: cFail.n.checked, needs: cNeeds.n.checked },
    };
    if (token.value.trim()) body.token = token.value.trim();
    paint(await put(body));
    token.value = '';
    msg.textContent = 'saved';
  };

  document.body.appendChild(back);
  fetch('/api/push').then((r) => r.json()).then(paint).catch(() => { state.textContent = 'Server not responding'; });
}

/* ------------------------------------------------------- workspace chooser */
/* The chip in the top bar says which folder this window is about. Clicking it
   lists every workspace (open ones marked), opens a new window on another
   folder, renames this one or points it somewhere else. Nothing here deletes:
   "hide" only takes a workspace out of the list and out of "open all". */
const closedWorkspaces = () => (WS_LIST?.workspaces || []).filter((w) => !w.hidden && !w.live && w.name !== WS);
function paintWsChip() {
  const chip = document.getElementById('wsChip');
  if (!chip) return;
  chip.textContent = '';
  chip.appendChild(el('span', 'wsname', WS_ERR ? `Workspace ${WS_ERR}` : wsLabel()));
  if (ROOT && !WS_ERR) chip.appendChild(el('span', 'wsroot', short(ROOT)));
  if (ALL_FOLDERS && !WS_ERR) chip.appendChild(el('span', 'wsall', 'all folders'));
  const closed = closedWorkspaces().length;
  if (closed) chip.appendChild(el('span', 'wsbadge', String(closed)));
  chip.appendChild(el('span', 'wscaret', '▾'));
  chip.classList.toggle('bad', Boolean(WS_ERR));
  chip.title = WS_ERR
    ? 'The workspace could not be loaded — reload the page. Until then this window saves nothing.'
    : `Workspace "${wsLabel()}" — ${ROOT}\nClick: all workspaces, new window, change folder`
      + (closed ? `\n${closed} workspace${closed > 1 ? 's have' : ' has'} no open window right now` : '');
  paintWsBar();
}
/* "When I open flotilla, my workspaces should come back." A browser only
   lets a page open ONE window per click, and a restored-but-not-yet-loaded tab
   looks exactly like a closed one — so this never opens anything by itself.
   It shows up only in the first window (no other workspace has one open) and
   brings the rest back with one click. */
let WS_BAR_DISMISSED = false;
function paintWsBar() {
  const bar = document.getElementById('wsbar');
  if (!bar) return;
  const closed = closedWorkspaces();
  const othersOpen = (WS_LIST?.workspaces || []).some((w) => w.name !== WS && w.live);
  const show = !WS_BAR_DISMISSED && closed.length && !othersOpen;
  bar.hidden = !show;
  if (!show) return;
  bar.textContent = '';
  bar.appendChild(el('span', null, `${closed.length} workspace${closed.length > 1 ? 's are' : ' is'} not open: `));
  bar.appendChild(el('b', null, closed.map((w) => wsLabel(w, w.name)).join(' · ')));
  const go = el('button', 'btn small primary', closed.length > 1 ? 'Open all' : 'Open');
  const note = el('span', 'wsbarnote');
  go.onclick = () => { const blocked = openWorkspaceWindows(closed); note.textContent = blocked ? blockedText(blocked) : ''; setTimeout(loadWorkspaces, 3000); };
  const x = el('button', 'btn ghost small', '✕');
  x.title = 'Hide for this window';
  x.onclick = () => { WS_BAR_DISMISSED = true; bar.hidden = true; };
  bar.append(go, note, x);
}
const blockedText = (n) => `The browser blocked ${n} window${n === 1 ? '' : 's'}. Allow pop-ups for this page (icon at the right end of the address bar), then click again.`;
const wsUrl = (name) => location.pathname + (name === 'main' ? '' : '?ws=' + encodeURIComponent(name));
/** Opens (or, if the browser still knows the tab by name, focuses) each one.
 *  Returns how many the popup blocker swallowed. */
function openWorkspaceWindows(list) {
  let blocked = 0;
  for (const w of list) if (!window.open(wsUrl(w.name), 'flotilla-ws-' + w.name)) blocked++;
  return blocked;
}
async function loadWorkspaces() {
  try {
    const r = await fetch('/api/workspaces', { cache: 'no-store' });
    if (!r.ok) return;
    WS_LIST = await r.json();
  } catch { return; }
  paintWsChip();
  WS_DIALOG?.paint();
}
async function wsPost(body) {
  const r = await fetch('/api/workspaces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}
function setAllFolders(on) {
  ALL_FOLDERS = Boolean(on);
  if (WSINFO) WSINFO.allFolders = ALL_FOLDERS;
  WS_DIALOG?.paint();
  paintWsChip(); renderList(); updateAmbient();
  wsPost({ action: 'update', name: WS, allFolders: ALL_FOLDERS }).catch(() => {});
}

let WS_DIALOG = null;
function openWorkspaces({ create = false } = {}) {
  if (WS_DIALOG) { WS_DIALOG.close(); }
  const back = el('div', 'modal');
  const sheet = el('div', 'sheet wssheet');
  back.appendChild(sheet);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); WS_DIALOG = null; };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.onclick = (e) => { if (e.target === back) close(); };

  sheet.appendChild(el('h3', null, 'Workspaces'));
  sheet.appendChild(el('p', 'muted', 'Each window is a workspace for one folder: the list shows only its agents, and new agents start there. '
    + 'Everything is stored on the server (~/.flotilla) — closing the tab, clearing the cache or restarting deletes nothing.'));

  const inp = (v = '', ph = '') => { const n = el('input'); n.type = 'text'; n.value = v; n.placeholder = ph; n.autocomplete = 'off'; n.spellcheck = false; return n; };
  const field = (parent, label, node) => { const l = el('label', null, label); l.appendChild(node); parent.appendChild(l); return node; };

  // --- this window
  const mine = el('div', 'wsblock');
  mine.appendChild(el('h4', null, 'This window'));
  const row1 = el('div', 'wsfields');
  const title = field(row1, 'Name', inp(WSINFO?.title || '', baseName(ROOT) || WS));
  const root = field(row1, 'Folder', inp(ROOT, '~/code/…'));
  mine.appendChild(row1);
  const mineFoot = el('div', 'sheetfoot');
  const mineMsg = el('span', 'wsmsg');
  const save = el('button', 'btn small', 'Save');
  save.onclick = async () => {
    mineMsg.textContent = '…';
    try {
      const d = await wsPost({ action: 'update', name: WS, title: title.value, root: root.value });
      setWsInfo(d.ws); renderList(); updateAmbient(); loadWorkspaces();
      root.value = ROOT;
      mineMsg.textContent = 'saved';
    } catch (e) { mineMsg.textContent = e.message; }
  };
  for (const n of [title, root]) n.addEventListener('keydown', (e) => { if (e.key === 'Enter') save.click(); });
  // the way out of the folder filter, for this window only
  const allL = el('label', 'chk'); const allBox = el('input'); allBox.type = 'checkbox';
  allL.append(allBox, document.createTextNode(' Show agents from all folders'));
  allL.title = 'Off: the list shows only agents in this folder. On: all of them, as before workspaces.';
  allBox.onchange = () => setAllFolders(allBox.checked);
  mineFoot.append(allL, mineMsg, save);
  mine.appendChild(mineFoot);
  sheet.appendChild(mine);

  // --- all of them
  const all = el('div', 'wsblock');
  const allHead = el('div', 'wshead');
  allHead.appendChild(el('h4', null, 'All workspaces'));
  allHead.appendChild(el('div', 'spacer'));
  const openAll = el('button', 'btn small', '');
  allHead.appendChild(openAll);
  all.appendChild(allHead);
  const listNode = el('div', 'wslist');
  all.appendChild(listNode);
  const allMsg = el('div', 'wsmsg');
  all.appendChild(allMsg);
  sheet.appendChild(all);
  let showHidden = false;

  // --- a new window
  const newBlock = el('div', 'wsblock');
  newBlock.appendChild(el('h4', null, 'New window on a folder'));
  const row2 = el('div', 'wsfields');
  const nroot = field(row2, 'Folder', inp('', '~/code/my-repo'));
  const dl = el('datalist'); dl.id = 'wsFolders'; nroot.setAttribute('list', dl.id); newBlock.appendChild(dl);
  const ntitle = field(row2, 'Name (optional)', inp('', 'same as the folder'));
  newBlock.appendChild(row2);
  const sugg = el('div', 'wssugg');
  newBlock.appendChild(sugg);
  const newFoot = el('div', 'sheetfoot');
  const newMsg = el('span', 'wsmsg');
  const go = el('button', 'btn primary small', 'Open new window');
  go.onclick = async () => {
    if (!nroot.value.trim()) { newMsg.textContent = 'Enter a folder.'; nroot.focus(); return; }
    /* The window is opened INSIDE the click and pointed at its address once
       the server said yes — after an await the browser may no longer count
       this as your click and block the popup. */
    const win = window.open('about:blank', '_blank');
    newMsg.textContent = '…';
    try {
      const d = await wsPost({ action: 'create', root: nroot.value, title: ntitle.value });
      if (win) win.location.href = wsUrl(d.name);
      else newMsg.textContent = blockedText(1);
      if (win) { newMsg.textContent = ''; nroot.value = ''; ntitle.value = ''; }
      loadWorkspaces();
    } catch (e) {
      try { win?.close(); } catch {}
      newMsg.textContent = e.message;
    }
  };
  for (const n of [nroot, ntitle]) n.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
  newFoot.append(newMsg, go);
  newBlock.appendChild(newFoot);
  sheet.appendChild(newBlock);

  const foot = el('div', 'sheetfoot');
  const done = el('button', 'btn small', 'Close');
  done.onclick = close;
  foot.appendChild(done);
  sheet.appendChild(foot);

  const paint = () => {
    allBox.checked = ALL_FOLDERS;
    const list = (WS_LIST?.workspaces || []).slice()
      .sort((a, b) => (a.name === WS ? -1 : b.name === WS ? 1 : 0) || (b.usedAt || 0) - (a.usedAt || 0));
    const hidden = list.filter((w) => w.hidden && w.name !== WS && !w.live);
    listNode.textContent = '';
    if (!WS_LIST) listNode.appendChild(el('div', 'wsmsg', 'loading…'));
    for (const w of list) {
      // hidden only means "not in the list while nothing shows it" — an open
      // window on a hidden workspace is still listed
      if (w.hidden && w.name !== WS && !w.live && !showHidden) continue;
      const r = el('div', 'wsrow' + (w.name === WS ? ' me' : '') + (w.hidden ? ' hid' : ''));
      const dot = el('span', 'wsdot' + (w.live || w.name === WS ? ' on' : ''));
      dot.title = w.live || w.name === WS ? 'window open' : 'no window open';
      const txt = el('div', 'wstxt');
      const top = el('div', 'wsrowname', wsLabel(w, w.name));
      if (w.name === WS) top.appendChild(el('span', 'wstag', 'this window'));
      txt.appendChild(top);
      const bits = [short(w.root), `${w.agents} agents`];
      if (w.unread) bits.push(`${w.unread} unread`);
      bits.push(`${w.panes} Pane${w.panes === 1 ? '' : 's'}`);
      txt.appendChild(el('div', 'wsrowsub', bits.join(' · ')));
      r.append(dot, txt);
      if (w.name !== WS) {
        // an open one gets no button: a page cannot bring another tab to the
        // front, it could only open the same desk a second time
        if (!w.live) {
          const o = el('button', 'btn small', 'Open');
          o.onclick = () => { if (!window.open(wsUrl(w.name), 'flotilla-ws-' + w.name)) allMsg.textContent = blockedText(1); setTimeout(loadWorkspaces, 3000); };
          r.appendChild(o);
        } else r.appendChild(el('span', 'wstag', 'open'));
        if (w.name !== 'main') {
          const h = el('button', 'btn ghost small', w.hidden ? 'Show' : 'Hide');
          h.title = w.hidden ? 'Back into the list and into "Open all"' : 'Take it off the list — nothing is deleted, "show hidden" brings it back';
          h.onclick = async () => { try { await wsPost({ action: 'update', name: w.name, hidden: !w.hidden }); } catch (e) { allMsg.textContent = e.message; } loadWorkspaces(); };
          r.appendChild(h);
        }
      }
      listNode.appendChild(r);
    }
    if (hidden.length) {
      const t = el('div', 'wstoggle', showHidden ? `hide ${hidden.length} hidden` : `show ${hidden.length} hidden`);
      t.onclick = () => { showHidden = !showHidden; paint(); };
      listNode.appendChild(t);
    }
    const closed = closedWorkspaces();
    openAll.hidden = !closed.length;
    openAll.textContent = `Open all (${closed.length})`;
    openAll.onclick = () => { const b = openWorkspaceWindows(closed); allMsg.textContent = b ? blockedText(b) : ''; setTimeout(loadWorkspaces, 3000); };

    // folders agents work in that no workspace is about yet — one click fills the field
    const folders = WS_LIST?.folders || [];
    dl.textContent = '';
    for (const f of folders) dl.appendChild(Object.assign(el('option'), { value: short(f.root) }));
    sugg.textContent = '';
    const open = folders.filter((f) => !f.covered);
    if (open.length) {
      sugg.appendChild(el('span', 'wssugghead', 'Folders with agents but no workspace of their own:'));
      for (const f of open.slice(0, 8)) {
        const c = el('button', 'wschipbtn', `${short(f.root)} · ${f.agents}`);
        c.title = `${f.root} — ${f.agents} agent${f.agents === 1 ? '' : 's'}`;
        c.onclick = () => { nroot.value = short(f.root); nroot.focus(); };
        sugg.appendChild(c);
      }
    }
  };
  WS_DIALOG = { paint, close };
  paint();
  loadWorkspaces();
  document.body.appendChild(back);
  (create ? nroot : done).focus();
}

async function boot() {
  await loadDrafts();
  // a named window can be found again: "open" in the workspace list focuses
  // this tab instead of opening the same desk twice
  try { window.name = 'flotilla-ws-' + WS; } catch {}
  /* The desk is the one thing a failed request must not cost. A server in the
     middle of a restart answers nothing for a second or two, so this asks
     again instead of starting on an empty desk; if it never answers, the page
     says so and saves nothing (LAYOUT_READY stays false). */
  let saved = null, loaded = false;
  for (let i = 0; i < 8 && !loaded; i++) {
    try {
      const r = await fetch('/api/ui-state?ws=' + encodeURIComponent(WS), { cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      const s = await r.json();
      PREFS = { ...PREFS, ...(s.prefs || {}) };
      PREFS.collapsed ||= {};
      saved = s.workspaces?.[WS] || null;
      setWsInfo(s.ws || s.wsInfo?.[WS] || null);
      loaded = true;
    } catch { await new Promise((r) => setTimeout(r, 750 * (i + 1))); }
  }
  META = await (await fetch('/api/meta')).json();
  await refresh();

  // Restore the desk. Agents that no longer exist are dropped rather than
  // rendered as ghosts, and empty columns collapse with them.
  if (saved?.cols?.length) {
    LAYOUT = sanitizeLayout(saved);
    if (LAYOUT.cols.length) renderPanes();
  }
  LAYOUT_READY = loaded;
  if (!loaded) { WS_ERR = 'not loaded'; paintWsChip(); }
  $('#wsChip').onclick = () => openWorkspaces();
  loadWorkspaces();
  // once more after the other restored tabs had time to connect, so the
  // "not open" bar does not count a tab that was merely still loading
  setTimeout(loadWorkspaces, 4000);
  setInterval(loadWorkspaces, 30000);

  connectSSE();
  $('#btnNew').onclick = newComposePane;
  loadUsage();
  loadContext();
  loadMemory(false);
  if (location.hash === '#memory') toggleMemPanel();   // deep link, like #context

  $('#sortBy').value = PREFS.sort;
  $('#groupBy').value = PREFS.group;
  $('#sortBy').onchange = (e) => { PREFS.sort = e.target.value; savePrefs(); renderList(); };
  $('#groupBy').onchange = (e) => { PREFS.group = e.target.value; savePrefs(); renderList(); };
  // A new window is a new workspace, and a workspace is a FOLDER — so this asks
  // for one (like VS Code's "New Window" → "Open Folder") instead of cloning
  // this desk under a numbered name.
  $('#btnWindow').onclick = () => openWorkspaces({ create: true });
  $('#btnExport').onclick = exportInputs;
  const pipBtn = $('#btnPip');
  if ('documentPictureInPicture' in window) {
    pipBtn.appendChild(monitorIcon());
    pipBtn.onclick = () => (pipOpen() ? PIP.win.close() : openPip());
  } else {
    // Only Chromium can float a window over other apps. Offering a button that
    // cannot work is worse than not offering it.
    pipBtn.remove();
  }
  $('#btnArchiveView').onclick = () => { ARCHIVE_VIEW = !ARCHIVE_VIEW; renderList(); };
  /* Restart: ask the server to replace itself, then poll until a DIFFERENT
     pid answers and reload. Attached terminals drop — the agents keep running. */
  $('#btnRestart').onclick = async () => {
    const btn = $('#btnRestart');
    if (btn.disabled) return;
    if (!confirm('Restart flotilla? Open terminals are disconnected; the agents keep running.')) return;
    btn.disabled = true; btn.textContent = '…';
    let old = null;
    try { old = (await (await fetch('/api/restart', { method: 'POST' })).json()).pid; } catch {}
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const r = await fetch('/api/restart-probe', { cache: 'no-store' });
        if (r.ok && (await r.json()).pid !== old) return location.reload();
      } catch {}
    }
    btn.disabled = false; btn.textContent = '⟳';
    alert('The restart did not answer within 30 s — see flotilla.log.');
  };
  // "everything" = everything in THIS window's folder; another workspace's
  // unread marks are not this button's to clear
  $('#btnReadAll').onclick = async () => {
    const mine = AGENTS.filter((a) => a.unread && inWorkspace(a));
    for (const a of mine) a.unread = false;
    await fetch('/api/read-all', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys: mine.map(keyOf) }) }).catch(() => {});
    renderList(); updateAmbient();
  };

  /* One rebuild per burst of typing, not one per letter. 60ms is below the
     threshold where a list feels like it is lagging behind the caret, and it
     collapses a fast typist's ten keystrokes into one pass. */
  let searchT = null;
  $('#search').oninput = () => { clearTimeout(searchT); searchT = setTimeout(renderList, 60); };
  $('#showDone').onchange = renderList;
  /* The pointer's position in the list, kept as a node. A repaint held back
     because you were pointing at that row runs the moment you are not —
     without it the row would wait for the next payload, up to 1.5s of showing
     what it showed before you left. */
  $('#list').addEventListener('pointerover', (e) => { HOVER_ROW = e.target.closest?.('.row-agent') || null; });
  $('#list').addEventListener('pointerleave', () => { HOVER_ROW = null; if (LIST_DEFERRED) renderList(); });
  $('#showInteractive').onchange = renderList;
  /* The switch turns the TOP GROUP off, never a row: unchecked, the pinned
     chats sort in with everything else and keep their mark. */
  $('#pinsTop').checked = PREFS.pinsTop !== false;
  $('#pinsTop').onchange = (e) => { PREFS.pinsTop = e.target.checked; savePrefs(); renderList(); };
  $('#cmdlogClose').onclick = () => ($('#cmdlog').hidden = true);

  const snd = $('#btnSound');
  const paint = () => { snd.textContent = SOUND ? '🔔' : '🔕'; snd.title = SOUND ? 'Sound on' : 'Sound off'; };
  snd.onclick = () => { SOUND = !SOUND; localStorage.setItem('fleet.sound', SOUND ? 'on' : 'off'); paint(); if (SOUND) beep('done'); };
  paint();

  $('#btnPush').onclick = openPush;

  window.addEventListener('resize', () => { for (const k of paneKeys()) { try { PD.get(k)?.fit?.fit(); } catch {} } });
  window.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement === document.body) { e.preventDefault(); $('#search').focus(); }
    /* Escape used to close the last pane. It is a reflex key — you press it to
       dismiss a menu, leave a field, cancel a thought — and it was wired to
       destroy a whole view, undiscoverably. Nothing here closes panes. */
    // ⌥↑ / ⌥↓ jump through your prompts in the pane your cursor is in. NOT
    // inside the draft box: macOS binds ⌥↑/⌥↓ to paragraph moves there, and
    // silently stealing a text-editing key costs more than it saves. The two
    // buttons in the tab row work from anywhere.
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const tag = document.activeElement?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      const k = (FOCUSED && PD.has(FOCUSED)) ? FOCUSED : paneKeys().find((x) => PD.get(x)?.body);
      if (!k) return;
      e.preventDefault();
      jumpPrompt(k, e.key === 'ArrowUp' ? -1 : 1);
    }
  });
  window.addEventListener('pointerdown', () => { try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); AC.resume(); } catch {} }, { once: true });
}

boot();
