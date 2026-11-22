/* The lane rule lives alone so it can be imported by a test — server.mjs opens
   a socket at import time, so a test that pulls it in would start a second
   dashboard. This file has no imports and no side effects on purpose. */
/**
 * THE lane rule. Computed here and shipped in the snapshot so the browser never
 * has a second opinion — two copies of this drift, and a drifted copy is how an
 * agent ends up unread in one place and read in another.
 *
 * `status` comes from `claude agents --json`, which asks the daemon. `tempo`
 * comes from state.json, which is measured to sit unchanged for MINUTES while
 * an agent works — a real case had status:busy/state:working from the daemon
 * and state:done/tempo:idle in a file 12 minutes old. Gating "working" on
 * `tempo` therefore parked a running agent under "Ready". The live source
 * decides; the file is only a fallback.
 */
export function laneOf(a) {
  if (a.waitingFor || a.status === 'waiting') return 'needs';
  if (a.state === 'failed') return 'failed';
  /* `busy` used to win over everything, and that is what showed finished agents
     as running. Measured: the daemon reported status:busy for an agent whose
     OWN record in the same response said state:done — because two shells were
     still polling in the background. `busy` answers "is this process doing
     something", `state` answers "is this agent finished". Only the second one
     is the question the list asks.
     The old note below still holds, which is why this only overrules `busy`
     when the DAEMON is the one reporting the state: a state file is measured to
     sit stale for minutes, and trusting a stale "done" would park a running
     agent under Done — the same bug in the other direction. */
  if (a.stateLive) {
    // "blocked" means it cannot go on without you. It carried its reason all
    // along ("awaiting decision on…") and was being shown as Working.
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
