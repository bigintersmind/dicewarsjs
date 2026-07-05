#!/usr/bin/env node

/**
 * Turtle-from-winning-position probe (ad-hoc analysis, not a shipped gate).
 *
 * Question it answers: "which bots, when they hold a winning position (territory lead),
 * decline to press and PASS — freezing a game into a stall?" The browser AI-vs-AI mode is a
 * 7-player free-for-all that, until this probe surfaced the stall, had NO turn cap: a leader
 * that turtled hung the game indefinitely. The browser now caps at MAX_GAME_TURNS (300) in
 * src/controller/GameController.js; this measures the intrinsic tendency that cap backstops.
 *
 * Two direct metrics per bot, measured over a 7-seat field of the SAME bot (self-mirror — the
 * cleanest isolate: "if a browser game were all Bot-X, would it stall?"), plus a mixed field:
 *   - leadPassRate   = P(pass this turn | bot is the strict territory leader that turn)
 *   - dominantPassRate = P(pass | bot holds >= 40% of all live territory)
 *   - stalemateRate  = fraction of games that hit maxTurns with no winner (the stall symptom)
 * Context axes (overall): passRate, aggression (attacks/turn), winRate, meanTurns.
 *
 * Pass detection reuses the harness convention: a STOP step with 0 attacks since the last STOP is
 * a pass turn (isStopMove). Lead status is read from onTurn's post-turn state (territoryCount).
 *
 * Usage:
 *   node scripts/turtle-probe.mjs --games 60 --maxTurns 300
 *   node scripts/turtle-probe.mjs --bots Defensive,Strategist,Conqueror --games 40
 *   node scripts/turtle-probe.mjs --field mixed --games 60
 *   node scripts/turtle-probe.mjs --json > turtle.json
 */

import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { isStopMove } from '../src/arena/trajectoryExport.js';
import { getArg, hasFlag } from './lib/cli-utils.mjs';

const args = process.argv.slice(2);
const games = parseInt(getArg(args, 'games', '60'), 10);
const maxTurns = parseInt(getArg(args, 'maxTurns', '300'), 10);
const seats = parseInt(getArg(args, 'seats', '7'), 10);
const fieldMode = getArg(args, 'field', 'self'); // 'self' (mirror) | 'mixed'
const dominantShare = Number(getArg(args, 'dominant', '0.4'));
const asJson = hasFlag(args, 'json');
const byName = new Map(BUILT_IN_BOTS.map(b => [b.name, b]));
const defaultBots = [
  'Example',
  'Default',
  'Defensive',
  'Adaptive',
  'Strategist',
  'Lookahead',
  'Expectimax',
  'Conqueror',
  'Blitz',
  'Survivor',
];
const botNames = getArg(args, 'bots', defaultBots.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

for (const n of botNames) {
  if (!byName.has(n)) {
    console.error(`Unknown bot "${n}". Available: ${[...byName.keys()].join(', ')}`);
    process.exit(1);
  }
}

const log = (...a) => console.error(...a);

/**
 * Per-game probe: track, per seat, turtle-from-lead behavior. onStep flags a turn as a pass
 * (STOP with 0 attacks); onTurn reads the post-turn board to decide if the acting seat was the
 * strict leader / dominant / an endgame (<=3 alive) leader, then tallies. Reset the per-turn pass
 * flag each turn so a turn with no STOP (the victory turn) never inherits the prior turn's flag.
 */
function makeProbe(nSeats) {
  const seat = Array.from({ length: nSeats }, () => ({
    activeTurns: 0,
    passTurns: 0,
    attacks: 0,
    leaderTurns: 0,
    leaderPassTurns: 0,
    dominantTurns: 0,
    dominantPassTurns: 0,
    endgameLeadTurns: 0,
    endgameLeadPassTurns: 0,
    _sinceStop: 0,
    _turnWasPass: false,
  }));

  const onStep = step => {
    const s = seat[step.playerId];
    if (!s) return;
    if (isStopMove(step.chosenMove)) {
      s._turnWasPass = s._sinceStop === 0;
      s._sinceStop = 0;
    } else {
      s._sinceStop += 1;
      s.attacks += 1;
    }
  };

  const onTurn = (_turnNumber, state, actingPlayerId) => {
    const s = seat[actingPlayerId];
    const active = state.players.filter(p => !p.eliminated);
    const me = state.players[actingPlayerId];
    const total = active.reduce((a, p) => a + p.territoryCount, 0);
    const maxOther = active
      .filter(p => p.id !== actingPlayerId)
      .reduce((m, p) => Math.max(m, p.territoryCount), 0);
    const isLeader = me.territoryCount > maxOther; // strict plurality lead
    const share = total > 0 ? me.territoryCount / total : 0;
    const wasPass = s._turnWasPass === true;

    s.activeTurns += 1;
    if (wasPass) s.passTurns += 1;
    if (isLeader) {
      s.leaderTurns += 1;
      if (wasPass) s.leaderPassTurns += 1;
      if (active.length <= 3) {
        // Endgame all-8s zone — where the strategist #35 fix targeted the stall.
        s.endgameLeadTurns += 1;
        if (wasPass) s.endgameLeadPassTurns += 1;
      }
    }
    if (share >= dominantShare) {
      s.dominantTurns += 1;
      if (wasPass) s.dominantPassTurns += 1;
    }
    s._turnWasPass = false;
  };

  return { seat, onTurn, onStep };
}

/*
 * Fixed, diverse opponent pool for the MIXED field. When profiling bot X, the profiled seat = X
 * (rotated through every seat across rounds, seat-fair) and the remaining seats are filled from
 * this pool excluding X (first `seats-1`). All-distinct, so every
 * profiled bot faces a strong contested field of the SAME character — a lead is genuinely earned,
 * which is where turtle instinct (press vs sit) becomes visible. Strong searchers (Lookahead /
 * Expectimax) are included so leads are contested rather than trivially snowballed.
 */
const OPPONENT_POOL = [
  'Lookahead',
  'Expectimax',
  'Strategist',
  'Adaptive',
  'Default',
  'Defensive',
  'Conqueror',
];

/** Build the field for one rotation: profiled bot at `seatIndex`, opponents fill the rest. */
function buildField(botName, seatIndex, mode) {
  const bot = byName.get(botName);
  if (mode === 'self') {
    return Array.from({ length: seats }, (_, i) => ({ name: `${botName}#${i}`, fn: bot.fn }));
  }
  const opps = OPPONENT_POOL.filter(n => n !== botName)
    .slice(0, seats - 1)
    .map(n => byName.get(n));
  if (opps.length < seats - 1) {
    throw new Error(
      `OPPONENT_POOL too small: need ${seats - 1} opponents for "${botName}" but only ${opps.length} ` +
        `available. Add more distinct bots to OPPONENT_POOL.`
    );
  }
  const field = [];
  let oi = 0;
  for (let i = 0; i < seats; i++) {
    if (i === seatIndex) field.push({ name: `${botName}`, fn: bot.fn });
    else field.push({ name: opps[oi++].name, fn: opps[oi - 1].fn });
  }
  return field;
}

/**
 * Aggregate one bot over `seedCount` seeds. In 'self' mode all seats are the profiled bot (one
 * game per seed). In 'mixed' mode the profiled bot is rotated through every seat (seat-fair), so
 * each seed yields `seats` games — the profiled seat index is `rot`.
 */
function probeBot(botName, seedCount, mode) {
  const agg = {
    name: botName,
    mode,
    games: 0,
    stalemates: 0,
    wins: 0,
    turnSum: 0,
    activeTurns: 0,
    passTurns: 0,
    attacks: 0,
    leaderTurns: 0,
    leaderPassTurns: 0,
    dominantTurns: 0,
    dominantPassTurns: 0,
    endgameLeadTurns: 0,
    endgameLeadPassTurns: 0,
    leaderAtStalemateIsBot: 0,
  };
  const rotations = mode === 'self' ? 1 : seats;

  for (let g = 0; g < seedCount; g++) {
    for (let rot = 0; rot < rotations; rot++) {
      const seatIndex = mode === 'self' ? 0 : rot;
      const field = buildField(botName, seatIndex, mode);
      const profiledSeats =
        mode === 'self' ? new Set(field.map((_, i) => i)) : new Set([seatIndex]);
      const { seat, onTurn, onStep } = makeProbe(field.length);
      const seed = g * 100003 + rot * 7 + 17; // disjoint, deterministic
      const result = runMatch({ bots: field, seed, maxTurns, onTurn, onStep });

      agg.games += 1;
      agg.turnSum += result.turnCount;
      const stalemate = result.winner === null;
      if (stalemate) agg.stalemates += 1;

      const activeEnd = result.finalState.players.filter(p => !p.eliminated);
      let leaderId = -1;
      let leaderTerr = -1;
      for (const p of activeEnd) {
        if (p.territoryCount > leaderTerr) {
          leaderTerr = p.territoryCount;
          leaderId = p.id;
        }
      }
      if (stalemate && profiledSeats.has(leaderId)) agg.leaderAtStalemateIsBot += 1;
      if (result.winner !== null && profiledSeats.has(result.winner)) agg.wins += 1;

      for (const i of profiledSeats) {
        const s = seat[i];
        agg.activeTurns += s.activeTurns;
        agg.passTurns += s.passTurns;
        agg.attacks += s.attacks;
        agg.leaderTurns += s.leaderTurns;
        agg.leaderPassTurns += s.leaderPassTurns;
        agg.dominantTurns += s.dominantTurns;
        agg.dominantPassTurns += s.dominantPassTurns;
        agg.endgameLeadTurns += s.endgameLeadTurns;
        agg.endgameLeadPassTurns += s.endgameLeadPassTurns;
      }
    }
  }
  return agg;
}

const div = (a, b) => (b > 0 ? a / b : null);
const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const num = (x, d = 2) => (x == null ? '—' : x.toFixed(d));

function summarize(a) {
  return {
    name: a.name,
    mode: a.mode,
    games: a.games,
    leaderTurns: a.leaderTurns,
    dominantTurns: a.dominantTurns,
    endgameLeadTurns: a.endgameLeadTurns,
    stalemateRate: div(a.stalemates, a.games),
    leadPassRate: div(a.leaderPassTurns, a.leaderTurns),
    dominantPassRate: div(a.dominantPassTurns, a.dominantTurns),
    endgameLeadPassRate: div(a.endgameLeadPassTurns, a.endgameLeadTurns),
    passRate: div(a.passTurns, a.activeTurns),
    aggression: div(a.attacks, a.activeTurns),
    winRate: div(a.wins, a.games),
    meanTurns: div(a.turnSum, a.games),
    stallOwnerShare: div(a.leaderAtStalemateIsBot, a.stalemates),
    raw: a,
  };
}

function runField(mode) {
  const seedCount = games;
  const rotations = mode === 'self' ? 1 : seats;
  log(
    `\n=== ${mode.toUpperCase()} field — ${seats} seats, ${seedCount} seeds × ${rotations} rot = ` +
      `${seedCount * rotations} games/bot, maxTurns=${maxTurns}, dominant>=${(dominantShare * 100).toFixed(0)}% ===`
  );
  if (mode === 'mixed') log(`opponent pool: ${OPPONENT_POOL.join(', ')}`);
  const rows = [];
  for (const name of botNames) {
    const t0 = Date.now();
    const r = summarize(probeBot(name, seedCount, mode));
    rows.push(r);
    log(
      `  ${name.padEnd(12)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
        `stalemate ${pct(r.stalemateRate)}, leadPass ${pct(r.leadPassRate)} (n=${r.leaderTurns})`
    );
  }
  // Rank by leadPassRate (the direct "turtle from winning position" metric), desc.
  rows.sort((x, y) => (y.leadPassRate ?? -1) - (x.leadPassRate ?? -1));

  const H = [
    'Bot',
    'stalemate%',
    'leadPass%',
    'domPass%',
    'endgLeadP%',
    'pass%',
    'aggr/turn',
    'win%',
    'turns',
  ];
  log('');
  log(H.map((h, i) => (i === 0 ? h.padEnd(12) : h.padStart(11))).join(''));
  log('-'.repeat(12 + (H.length - 1) * 11));
  for (const r of rows) {
    log(
      [
        r.name.padEnd(12),
        pct(r.stalemateRate).padStart(11),
        pct(r.leadPassRate).padStart(11),
        pct(r.dominantPassRate).padStart(11),
        pct(r.endgameLeadPassRate).padStart(11),
        pct(r.passRate).padStart(11),
        num(r.aggression).padStart(11),
        pct(r.winRate).padStart(11),
        num(r.meanTurns, 0).padStart(11),
      ].join('')
    );
  }
  return rows;
}

log(`Turtle-from-winning-position probe — bots: ${botNames.join(', ')}`);
const start = Date.now();
const modes = fieldMode === 'both' ? ['mixed', 'self'] : [fieldMode];
const out = {};
for (const m of modes) out[m] = runField(m);
log(`\nTotal ${((Date.now() - start) / 1000).toFixed(1)}s`);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ config: { fieldMode, seats, games, maxTurns, dominantShare, opponentPool: OPPONENT_POOL }, fields: out }, null, 2)}\n`
  );
}
