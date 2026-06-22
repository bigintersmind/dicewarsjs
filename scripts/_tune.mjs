#!/usr/bin/env node
/*
 * ml-bot eval-param tuning harness for ai_expectimax (retained for re-tuning).
 *
 * Evaluates one or more candidate param configs in the real 7-bot FFA field
 * (the candidate replaces the Expectimax slot via makeExpectimax(cfg)), and
 * reports each candidate's field win%, paired per-game edge vs Strategist, and
 * ELO. Emits a JSON array on the last stdout line for machine parsing; a human
 * table goes to stderr.
 *
 * Usage:
 *   node scripts/_tune.mjs --games 600 --seed 1 --configs '[{},{"attackThreshold":1.0,"threat":2.0}]'
 */
import { runArena } from '../src/arena/arenaRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeExpectimax } from '../src/ai/ai_expectimax.js';
import { adaptLegacyBot } from '../src/arena/legacyBotAdapter.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const games = parseInt(arg('games', '600'), 10);
const baseSeed = parseInt(arg('seed', '1'), 10);
const configs = JSON.parse(arg('configs', '[{}]'));

// Normal CDF for the paired sign-test p-value.
function normCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014337 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function evalConfig(cfg) {
  const candFn = adaptLegacyBot(makeExpectimax(cfg), 'Expectimax');
  const field = BUILT_IN_BOTS.map(b =>
    b.name === 'Expectimax' ? { name: 'Expectimax', fn: candFn } : { name: b.name, fn: b.fn }
  );
  const res = runArena({ bots: field, gameCount: games, baseSeed });
  const cand = res.bots.find(b => b.name === 'Expectimax');
  const strat = res.bots.find(b => b.name === 'Strategist');
  const look = res.bots.find(b => b.name === 'Lookahead');

  let candBetter = 0,
    stratBetter = 0;
  for (const m of res.matches) {
    const cp = m.botStats.find(s => s.name === 'Expectimax').placement;
    const sp = m.botStats.find(s => s.name === 'Strategist').placement;
    if (cp < sp) candBetter++;
    else if (sp < cp) stratBetter++;
  }
  const nPair = candBetter + stratBetter;
  const z = nPair > 0 ? (candBetter - nPair / 2) / Math.sqrt(nPair / 4) : 0;
  const p = nPair > 0 ? 2 * (1 - normCdf(Math.abs(z))) : 1;

  return {
    cfg,
    candWin: +((cand.wins / cand.gamesPlayed) * 100).toFixed(2),
    stratWin: +((strat.wins / strat.gamesPlayed) * 100).toFixed(2),
    lookWin: +((look.wins / look.gamesPlayed) * 100).toFixed(2),
    candElo: Math.round(cand.elo),
    stratElo: Math.round(strat.elo),
    pairedWinRate: nPair > 0 ? +((candBetter / nPair) * 100).toFixed(1) : 0,
    z: +z.toFixed(2),
    p: +p.toExponential(2),
    /*
     * runArena is fault-tolerant: it drops failed matches and aborts past a 50%
     * failure rate (see arenaRunner.js). A verdict from a silently-truncated
     * sample is worse than no verdict, so a clean run is required to claim BEATS.
     */
    beatsStrat: candBetter > stratBetter && p < 0.05 && !res.aborted && res.failedGames === 0,
    failedGames: res.failedGames,
    aborted: res.aborted,
    games: res.totalGames,
  };
}

const out = configs.map(evalConfig);
for (const r of out) {
  if (r.aborted || r.failedGames > 0) {
    process.stderr.write(
      `WARNING: ${r.failedGames} game(s) failed${r.aborted ? ' — RUN ABORTED' : ''}; ` +
        `stats below are from ${r.games} surviving game(s) only for ${JSON.stringify(r.cfg)}\n`
    );
  }
  process.stderr.write(
    `cand ${String(r.candWin).padStart(5)}%  strat ${String(r.stratWin).padStart(5)}%  look ${String(r.lookWin).padStart(5)}%  ` +
      `paired ${String(r.pairedWinRate).padStart(5)}% (p=${r.p})  ${r.beatsStrat ? 'BEATS' : '----'}  ${JSON.stringify(r.cfg)}\n`
  );
}
console.log(JSON.stringify(out));
