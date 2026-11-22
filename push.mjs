// ---------------------------------------------------------------------------
// push.mjs — the phone half of flotilla.
//
// Two long-lived HTTPS connections to an ntfy server, both opened FROM this
// machine: one publishes ("agent 3 is finished"), one listens for what you
// type back on the phone. That direction matters more than it looks — the
// fleet keeps binding 127.0.0.1, no port is opened, no tunnel is dug, and the
// phone never talks to this machine at all. It talks to ntfy; so do we.
//
// The topic name IS the password. ntfy has no per-topic secret beyond it (and
// no end-to-end encryption), so everything here is built around one rule:
// A NOTIFICATION CARRIES A POINTER, NEVER CONTENT. Name, folder, lane, id —
// the things you need to decide whether to look. Never a prompt, never a
// path, never a line of the transcript, unless you explicitly ask for it.
//
// Inbound is off until you turn it on, because a topic name that leaks is a
// stranger typing into your agents.
// ---------------------------------------------------------------------------
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = {
  enabled: false,
  server: 'https://ntfy.sh',
  topic: '',
  token: '',                                    // ntfy access token (tk_…), optional
  lanes: { done: true, failed: true, needs: true },
  replies: false,                               // inbound: OFF until you say so
  detail: false,                                // false = pointer only (see above)
  quietMs: 20000,                               // per agent+lane, kills the double-fire
};

let FILE = null;
let cfg = null;

/** Config lives beside ui-state.json, in the one directory this program writes. */
export function initPush(dataDir) { FILE = path.join(dataDir, 'push.json'); }

async function load() {
  if (cfg) return cfg;
  let saved = {};
  try { saved = JSON.parse(await fsp.readFile(FILE, 'utf8')); } catch {}
  cfg = { ...DEFAULTS, ...saved, lanes: { ...DEFAULTS.lanes, ...(saved.lanes || {}) } };
  return cfg;
}

/** 0600: the file holds the topic name, and the topic name is the password. */
async function save() {
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(tmp, FILE);
  await fsp.chmod(FILE, 0o600).catch(() => {});
}

/** What the browser may see. The token never leaves this process — a dashboard
 *  that renders it once has printed it into a screenshot forever. */
export async function pushState() {
  const c = await load();
  return {
    enabled: c.enabled, server: c.server, topic: c.topic, hasToken: Boolean(c.token),
    lanes: c.lanes, replies: c.replies, detail: c.detail,
    subscribed: SUB.alive, lastError: SUB.lastError, lastIn: SUB.lastIn, sent: STATS.sent,
  };
}

export async function setPush(patch) {
  const c = await load();
  if (typeof patch.enabled === 'boolean') c.enabled = patch.enabled;
  if (typeof patch.server === 'string' && patch.server.trim()) c.server = patch.server.trim().replace(/\/+$/, '');
  if (typeof patch.topic === 'string') c.topic = patch.topic.trim().replace(/[^\w\-.]/g, '');
  if (typeof patch.token === 'string') c.token = patch.token.trim();   // '' clears it
  if (typeof patch.replies === 'boolean') c.replies = patch.replies;
  if (typeof patch.detail === 'boolean') c.detail = patch.detail;
  if (patch.lanes) for (const k of ['done', 'failed', 'needs']) if (typeof patch.lanes[k] === 'boolean') c.lanes[k] = patch.lanes[k];
  await save();
  syncSubscription();
  return pushState();
}

/** A topic you did not invent yourself. 160 bits of base32 — long enough that
 *  guessing it is not a strategy, short enough to retype onto a phone once. */
export function suggestTopic() {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';           // no l/o/0/1
  const b = crypto.randomBytes(20);
  return 'flotilla-' + [...b].map((x) => a[x & 31]).join('');
}

const STATS = { sent: 0 };
const OWN = new Set();          // ids of messages WE published — never read back

function auth(c) { return c.token ? { authorization: 'Bearer ' + c.token } : {}; }

/** One publish. Returns the ntfy message id so the listener can skip it. */
async function publish(c, body) {
  const res = await fetch(`${c.server}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(c) },
    body: JSON.stringify({ topic: c.topic, ...body }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${txt.slice(0, 200)}`);
  let id = null;
  try { id = JSON.parse(txt).id || null; } catch {}
  if (id) { OWN.add(id); if (OWN.size > 400) OWN.delete(OWN.values().next().value); }
  STATS.sent++;
  return id;
}

// ------------------------------------------------------------------ outbound

const LANE_WORD = { done: 'done', failed: 'failed', needs: 'needs you' };
const LANE_TAG = { done: 'white_check_mark', failed: 'x', needs: 'raising_hand' };
const LANE_PRIO = { done: 3, failed: 4, needs: 4 };

const lastFire = new Map();     // `${key}|${lane}` -> when
export let LAST_TARGET = null;  // the agent a bare reply belongs to

/**
 * A lane edge became a push. Called from trackLanes, which is the ONE place a
 * lane change is an event — the sound, the unread dot and this all read the
 * same edge, so they can never disagree about what "finished" means.
 */
export async function notifyLane(agent, lane, { detailLine = '' } = {}) {
  const c = await load();
  if (!c.enabled || !c.topic || !c.lanes[lane]) return;

  const key = agent.id || ('sess:' + agent.sessionId);
  const gate = `${key}|${lane}`;
  const now = Date.now();
  if (now - (lastFire.get(gate) || 0) < c.quietMs) return;
  lastFire.set(gate, now);

  const name = String(agent.name || agent.id || 'agent').slice(0, 60);
  const folder = agent.cwd ? path.basename(agent.cwd) : '';
  const id = agent.id || '';
  LAST_TARGET = id || null;

  /* THE POINTER, NOT THE CONTENT. The folder's basename is in here because it
     is how you tell two agents apart at a glance; the path above it is not,
     and neither is anything the agent said. `detail` opens that door on
     purpose, one switch, with the consequence written next to it in the UI. */
  const lines = [folder && `📁 ${folder}`, id && `#${id}`].filter(Boolean);
  if (c.detail && detailLine) lines.push('', detailLine.slice(0, 300));

  const actions = [];
  if (c.replies && id) {
    /* One tap sends a reply through the same topic a typed one comes back on,
       so it lands in the same gate and the same log. `http` actions are run by
       the phone against ntfy — nothing here is reachable from outside. */
    const say = (label, text) => ({
      action: 'http', label, method: 'POST', url: `${c.server}/${c.topic}`,
      headers: { ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}) },
      body: `#${id} ${text}`, clear: true,
    });
    if (lane === 'needs') actions.push(say('Yes', 'yes'), say('Continue', 'continue'));
    else actions.push(say('Continue', 'continue'));
  }

  try {
    await publish(c, {
      title: `${name} — ${LANE_WORD[lane] || lane}`,
      message: lines.join('\n') || name,
      tags: [LANE_TAG[lane] || 'satellite'],
      priority: LANE_PRIO[lane] || 3,
      actions: actions.length ? actions : undefined,
    });
  } catch (e) { SUB.lastError = String(e.message || e); }
}

/** A push that is not about an agent: the test button, and the receipt the
 *  phone gets after a reply so you can see it landed. */
export async function notifyPlain(title, message, { priority = 3 } = {}) {
  const c = await load();
  if (!c.enabled || !c.topic) throw new Error('Push is off or no topic is set');
  return publish(c, { title, message, priority, tags: ['satellite'] });
}

// ------------------------------------------------------------------- inbound

const SUB = { alive: false, stop: null, lastError: null, lastIn: null, gen: 0 };
let ROUTE = null;               // set by startPush(): (id, text) => Promise

/* `#abc123 text` picks an agent, anything else goes to the one we last pushed
   about. That is the whole addressing scheme, and it is the right one: nine
   replies out of ten answer the notification that just woke you up. */
const ADDRESSED = /^\s*#?([0-9a-f]{6,16})\b[:,]?\s*([\s\S]*)$/i;

let lastAccept = 0;

async function handleIncoming(m) {
  const c = await load();
  if (!c.replies || !ROUTE) return;
  if (m.event !== 'message') return;             // open / keepalive / poll_request

  /* AN INBOUND MESSAGE HAS NO TITLE. Everything this file publishes sets one;
     nothing a phone can send does — not the ntfy app's message box, not the
     tap-to-reply action button. That asymmetry is the loop guard, and it has
     to be structural: the id set below LOSES THE RACE. Measured 2026-09-09 —
     ntfy had already broadcast our own "no target" notice to the listening
     stream before the POST returned the id we would have skipped it by, and
     the reply to that notice was itself a notice. A loop at one message every
     three seconds, forever, on a public topic. */
  if (m.title) return;
  if (m.id && OWN.has(m.id)) return;             // belt as well as braces
  const text = String(m.message || '').trim();
  if (!text) return;

  /* A crude throttle, and deliberately crude: this is a channel a stranger
     could reach if the topic name ever leaks, and a burst is the shape that
     does damage. One message every three seconds is faster than a thumb. */
  const now = Date.now();
  if (now - lastAccept < 3000) return;
  lastAccept = now;

  let id = null, body = text;
  const m2 = ADDRESSED.exec(text);
  if (m2 && m2[2].trim()) { id = m2[1].toLowerCase(); body = m2[2].trim(); }
  else id = LAST_TARGET;
  if (!id) { await notifyPlain('flotilla', 'No target — write `#<id> text`').catch(() => {}); return; }

  SUB.lastIn = { at: now, id, text: body.slice(0, 80) };
  try {
    const r = await ROUTE(id, body);
    await notifyPlain('→ ' + (r?.name || id), r?.ok ? 'sent' : 'NOT sent: ' + (r?.error || 'unknown'),
      { priority: r?.ok ? 2 : 4 }).catch(() => {});
  } catch (e) {
    SUB.lastError = String(e.message || e);
    await notifyPlain('→ ' + id, 'NOT sent: ' + SUB.lastError, { priority: 4 }).catch(() => {});
  }
}

/** The listening half. One streaming GET that ntfy holds open; when it drops
 *  (laptop lid, wifi, a server restart) we come back with a growing gap, so a
 *  server that is down does not get hammered by a dashboard nobody is watching. */
async function subscribeLoop(gen) {
  let wait = 1000;
  while (gen === SUB.gen) {
    const c = await load();
    if (!c.enabled || !c.replies || !c.topic) { SUB.alive = false; return; }
    const ctl = new AbortController();
    SUB.stop = () => ctl.abort();
    try {
      /* `since=now`, never `since=all`: a reply typed while this machine was
         asleep is DROPPED on purpose. ntfy caches for 12 h, and replaying a
         12-hour-old "yes" into an agent that has long moved on is a worse
         failure than a message that never arrives — you can see the one, you
         cannot see the other. */
      const res = await fetch(`${c.server}/${c.topic}/json?since=${Math.floor(Date.now() / 1000)}`,
        { headers: { ...auth(c) }, signal: ctl.signal });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
      SUB.alive = true; SUB.lastError = null; wait = 1000;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (gen === SUB.gen) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          try { await handleIncoming(JSON.parse(line)); } catch {}
        }
      }
    } catch (e) {
      if (gen !== SUB.gen) return;
      SUB.lastError = String(e.message || e);
    }
    SUB.alive = false;
    if (gen !== SUB.gen) return;
    await new Promise((r) => setTimeout(r, wait));
    wait = Math.min(wait * 2, 60000);
  }
}

function syncSubscription() {
  SUB.gen++;                                     // every old loop reads this and stops
  /* Cleared HERE, not in the loop. A generation that has been superseded
     returns from wherever it happens to be — mid-fetch, mid-read — and the
     path it takes out does not run the line that would clear this. The panel
     then reads "listening" over a socket that is being torn down. */
  SUB.alive = false;
  try { SUB.stop?.(); } catch {}
  SUB.stop = null;
  const gen = SUB.gen;
  load().then((c) => { if (c.enabled && c.replies && c.topic) subscribeLoop(gen); });
}

/**
 * Wire it up. `route(id, text)` is the fleet's own "type this into that agent"
 * — this module knows nothing about PTYs, and the reply path is therefore
 * exactly the path the dashboard's Send button takes.
 */
export function startPush(dataDir, route) {
  initPush(dataDir);
  ROUTE = route;
  syncSubscription();
}
