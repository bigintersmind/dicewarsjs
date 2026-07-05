#!/usr/bin/env node

/**
 * Behavioral-Eval Harness — CLI
 *
 * Profiles bots across a seat-fair seed sweep on behavioral axes (aggression, dice
 * reserve, kills, turns-to-win, placement, …) and reports each axis as mean ± 95% CI,
 * plus a PAIRED comparison of every profiled bot against a control. This answers "is
 * the bot DIFFERENT, and how?" — the complement to `ppo:gate`'s "is it STRONGER?".
 * Full spec + rationale: docs/ml-bot/EVAL_HARNESS.md.
 *
 * Pairing is the fixed-standard-field design (agreed): every profiled bot occupies the
 * one profiled seat in an IDENTICAL opponent field, so all face the same opponents and
 * the control comparison is paired at the seed/map level (NOT within-game — honest about
 * its strength). Personas are deliberately NOT pitted against each other.
 *
 * A profiled/control entry is either a built-in name (`Lookahead`) OR a freshly-exported
 * persona weights file as `Name=path/to/weights.js` — the same loadExportedPolicy→makeBC
 * path (parity-checked) `ppo:gate` uses. When a profiled bot's name matches a
 * PERSONA_SIGNATURES entry (e.g. `Blitz`), its pre-registered signature is gated PASS/FAIL
 * against the control (|Δ| ≥ MDE AND significant in the expected direction). The placeholder
 * MDEs are calibrated from a pilot via `--mde axis:value,...`. Gated signatures are then
 * Holm-adjusted as one confirmatory family (§3.3; m defaults to the PERSONA_SIGNATURES
 * registry count, override with `--holm-family N`) — CONFIRMED = single-test gate AND Holm.
 *
 * Usage:
 *   npm run behavior:profile                                   # defaults: Strategist vs Defensive control
 *   npm run behavior:profile -- --bots Strategist,Expectimax --control Defensive --runs 10 --games 30
 *   npm run behavior:profile -- --opponents Default,Adaptive,Example,Expectimax,Lookahead --reference Lookahead
 *   # Gate a freshly-trained persona's exported weights against the matched Conqueror control:
 *   npm run behavior:profile -- --bots Blitz=ml/runs/ppo-blitz/blitz.weights.js \
 *                               --control Conqueror=ml/runs/ppo-conqueror/conqueror.weights.js \
 *                               --mde aggression:1.5,turnsToWin:8
 *   npm run behavior:profile -- --json > profile.json
 */

import { runMatch } from '../src/arena/matchRunner.js';
import { BUILT_IN_BOTS } from '../src/arena/builtInBots.js';
import { makeBC } from '../src/ai/ai_bc.js';
import { rotatedField } from './lib/ppo-gate-core.mjs';
import { loadExportedPolicy, siblingFixturePath } from './lib/load-bc-policy.mjs';
import { getArg, hasFlag } from './lib/cli-utils.mjs';
import {
  makeCapture,
  profileGameFromCapture,
  reduceRun,
  summarizeAxis,
  compareToControl,
  signatureDetail,
  holmSignatures,
  parseBotSpec,
  parseMdeOverrides,
  AXES,
  PERSONA_SIGNATURES,
  SIGNATURE_FAMILY_SIZE,
  DEFAULT_MDE,
} from './lib/behavior-core.mjs';

const args = process.argv.slice(2);

const runCount = parseInt(getArg(args, 'runs', '10'), 10);
const gamesPerRun = parseInt(getArg(args, 'games', '30'), 10);
// `reference` is validated as an opponent seat and echoed into the report, but the paired
// comparison is always against `control` (not the reference) — it's a labeled seat only.
const referenceName = getArg(args, 'reference', 'Lookahead');
// --bots / --control / --opponents entries are each `Name` (built-in) or `Name=weights.js` specs.
const controlSpec = parseBotSpec(getArg(args, 'control', 'Defensive'));
const controlName = controlSpec.name;
const botSpecs = getArg(args, 'bots', 'Strategist')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseBotSpec);
const opponentSpecs = getArg(args, 'opponents', 'Default,Adaptive,Example,Expectimax,Lookahead')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseBotSpec);
const botNames = botSpecs.map(s => s.name);
const opponentNames = opponentSpecs.map(s => s.name);
const quarantine = !hasFlag(args, 'no-quarantine');
const asJson = hasFlag(args, 'json');

// Calibrated per-axis MDEs for the signature gate (defaults are placeholders until a pilot).
let mde;
try {
  mde = parseMdeOverrides(getArg(args, 'mde', ''), DEFAULT_MDE);
} catch (err) {
  console.error(`Invalid --mde: ${err.message}`);
  process.exit(1);
}

// Registered confirmatory family size m for the Holm step-down (§3.3). Defaults inside
// holmSignatures to the PERSONA_SIGNATURES registry count; override (e.g. `--holm-family 5`
// when the Blitz escalation registers its 5th test) — never below the REGISTERED family
// (PERSONAS §10.5 registers 4 or 5; anything smaller would un-adjust the family).
const holmFamilyRaw = getArg(args, 'holm-family', '');
const holmFamily = holmFamilyRaw === '' ? null : Number(holmFamilyRaw);
if (holmFamily != null && (!Number.isInteger(holmFamily) || holmFamily < 1)) {
  console.error('Invalid --holm-family: need a positive integer (the registered family size m).');
  process.exit(1);
}

if (!Number.isFinite(runCount) || runCount < 2) {
  console.error('Invalid --runs: need an integer >= 2 (a CI needs >= 2 runs).');
  process.exit(1);
}
if (!Number.isFinite(gamesPerRun) || gamesPerRun < 1) {
  console.error('Invalid --games: need a positive integer.');
  process.exit(1);
}
if (botNames.length === 0) {
  console.error('Invalid --bots: need at least one bot to profile.');
  process.exit(1);
}
// A duplicate opponent would make every game throw "Bot names must be unique" deep in the sweep;
// catch the typo here with a message that points at the actual cause.
if (new Set(opponentNames).size !== opponentNames.length) {
  console.error(
    `--opponents has duplicate names: [${opponentNames.join(', ')}]. Each seat must be distinct.`
  );
  process.exit(1);
}

// --- Resolve bots: built-in by name, or a parity-checked weights file (Name=path) ---

const byName = new Map(BUILT_IN_BOTS.map(b => [b.name, b]));
// Per-weights-bot {params, parity} so the header can show what was loaded (mirrors ppo:gate).
const loadedBots = [];

/**
 * Resolve one parsed spec to `{ name, fn }`. A bare name hits the built-in registry; a
 * `Name=weights.js` spec is dynamic-imported + parity-checked (fail loud) and wrapped exactly
 * like the in-browser bot via `makeBC({ policy })`. Exits with a clear message on any failure.
 */
async function resolveSpec({ name, weightsPath }) {
  if (!name) {
    console.error('A bot spec has an empty name (expected `Name` or `Name=path/to/weights.js`).');
    process.exit(1);
  }
  if (weightsPath == null) {
    const b = byName.get(name);
    if (!b) {
      console.error(
        `Unknown bot "${name}". Available built-ins: ${[...byName.keys()].join(', ')} ` +
          `(or pass a weights file as ${name}=path/to/weights.js).`
      );
      process.exit(1);
    }
    return { name: b.name, fn: b.fn };
  }
  if (!weightsPath) {
    console.error(`Weights bot "${name}" has an empty path (expected ${name}=path/to/weights.js).`);
    process.exit(1);
  }
  // The exported persona weights follow the capacity-probe layout: foo.weights.js ↔ foo.fixture.json.
  const fixturePath = siblingFixturePath(weightsPath);
  try {
    const { policy, parity, params } = await loadExportedPolicy({
      weightsPath,
      fixturePath,
      label: name,
    });
    loadedBots.push({ name, params, parity, weightsPath });
    return { name, fn: makeBC({ policy }) };
  } catch (err) {
    // loadExportedPolicy throws precise, user-facing messages for every EXPECTED failure (missing
    // file/fixture, no BC_POLICY, each parity mode). For those the message is enough; for an
    // UNEXPECTED loader bug (e.g. a TypeError) keep the stack so it isn't permanently disguised as
    // a bad-weights-file error.
    console.error(
      `\nFailed to load weights bot "${name}" (${weightsPath}): ${err.stack ?? err.message}`
    );
    process.exit(1);
  }
}

// --- Validate the fixed-field invariants (keeps every field identical in size & opponents) ---

const profiledNames = [...new Set([...botNames, controlName])];
const oppSet = new Set(opponentNames);
const collide = profiledNames.filter(n => oppSet.has(n));
if (collide.length) {
  console.error(
    `Profiled bot(s) [${collide.join(', ')}] also appear in --opponents. The profiled seat must ` +
      `be disjoint from the fixed opponent field so every field is identical. Remove them from one side.`
  );
  process.exit(1);
}
if (!oppSet.has(referenceName)) {
  console.error(`--reference "${referenceName}" must be one of --opponents (it fills a seat).`);
  process.exit(1);
}
if (opponentSpecs.length < 1) {
  console.error('Need at least one opponent.');
  process.exit(1);
}

// Resolve after validation. Profiled = the requested bots + the control (deduped by name, first
// spec wins), each profiled in the same field so the control comparison shares seed blocks.
const opponents = [];
for (const spec of opponentSpecs) opponents.push(await resolveSpec(spec));
const profiledSpecByName = new Map();
for (const spec of [...botSpecs, controlSpec]) {
  if (!profiledSpecByName.has(spec.name)) profiledSpecByName.set(spec.name, spec);
}
const profiled = [];
for (const spec of profiledSpecByName.values()) profiled.push(await resolveSpec(spec));

// Fail FAST on a missing MDE, not post-sweep. Every non-control profiled bot whose name matches a
// PERSONA_SIGNATURES key gets its signature gated below (signatureDetail), which THROWS if a
// signature axis has no MDE. DEFAULT_MDE covers today's personas so this can't fire now, but if a
// future signature axis lacks an MDE this would otherwise surface as an uncaught stack AFTER the
// full runs×games×field sweep — minutes wasted. Catch it here with the other config errors instead.
for (const bot of profiled) {
  if (bot.name === controlName) continue;
  const sig = PERSONA_SIGNATURES[bot.name];
  if (!sig) continue;
  const missing = sig.axes.map(a => a.axis).filter(axis => mde[axis] == null);
  if (missing.length) {
    console.error(
      `Persona "${bot.name}" has signature axes with no registered MDE: [${missing.join(', ')}]. ` +
        `Add them to DEFAULT_MDE or pass --mde ${missing.map(a => `${a}:<value>`).join(',')}.`
    );
    process.exit(1);
  }
}

// Fail fast on an under-sized Holm family too (before the sweep burns minutes of games). The
// floor is the REGISTERED family size, not just the personas gated in this invocation: the only
// registered values are SIGNATURE_FAMILY_SIZE (4) and 5 (the Blitz escalation, PERSONAS §10.5) —
// a smaller m would loosen the step-down thresholds and quietly un-adjust the family.
const gatedPersonaCount = profiled.filter(
  b => b.name !== controlName && PERSONA_SIGNATURES[b.name]
).length;
const holmFloor = Math.max(SIGNATURE_FAMILY_SIZE, gatedPersonaCount);
if (holmFamily != null && holmFamily < holmFloor) {
  console.error(
    `--holm-family ${holmFamily} is below the registered family size (${holmFloor} — ` +
      `PERSONAS §10.5 registers ${SIGNATURE_FAMILY_SIZE}, or 5 when the Blitz escalation fires). ` +
      `The registered family may grow, never shrink: a smaller m un-adjusts the step-down.`
  );
  process.exit(1);
}

const fieldSize = opponents.length + 1; // profiled seat + fixed opponents
const STRIDE = Math.max(1_000_000, gamesPerRun * 1000);

const log = (...a) => console.error(...a); // human output → stderr so --json owns stdout

log(
  `Behavioral profile: ${runCount} runs × ${gamesPerRun} games × ${fieldSize} rotations ` +
    `(${runCount * gamesPerRun * fieldSize} matches/bot)`
);
log(`  profiled: ${profiledNames.join(', ')}   control: ${controlName}`);
log(
  `  field (${fieldSize} seats): [profiled] + ${opponentNames.join(', ')}   ref: ${referenceName}`
);
for (const lb of loadedBots) {
  log(
    `  loaded ${lb.name}: ${lb.params.toLocaleString()} params, ` +
      `parity ${lb.parity.toExponential(1)} (${lb.weightsPath})`
  );
}
log(`  quarantine forced-end games: ${quarantine ? 'on' : 'off'}\n`);

// --- Sweep: profile each bot in the one profiled seat of an identical field ---

const NULL_RUN = Object.fromEntries(AXES.map(a => [a, null]));

// Quarantine policy (§3.7): drop a game if ANY seat shows a forced-end signal.
const isForcedEnd = s => s.errors > 0 || s.invalidMoves > 0 || s.maxMovesHit > 0;

// A NULL_RUN has winPct === null (no game contributed); a live run always has a numeric winPct
// (0 if it never won). So this counts the runs that actually carry behavioral data.
const liveRunCount = perRun => perRun.filter(r => r.winPct != null).length;

/**
 * Run the full seed×rotation sweep for one profiled bot. Returns the per-run reduceRun() plus
 * per-bot played/quarantined tallies so the report can surface how much sample each bot kept
 * (a fully-quarantined bot must NOT look like a measured "no difference" — see the output below).
 */
function sweepBot(bot) {
  const baseField = [bot, ...opponents]; // profiled bot at index 0
  const perRun = [];
  let played = 0;
  let quarantined = 0;
  for (let run = 0; run < runCount; run++) {
    const baseSeed = run * STRIDE + 1;
    const profiles = [];
    for (let s = 0; s < gamesPerRun; s++) {
      const seed = baseSeed + s;
      for (let rot = 0; rot < fieldSize; rot++) {
        // Under rotation `rot`, field[0] (the profiled bot) sits at seat `rot`.
        const field = rotatedField(baseField, rot);
        const pi = rot;
        const { capture, onTurn, onStep } = makeCapture(pi);
        try {
          const result = runMatch({ bots: field, seed, onTurn, onStep });
          played += 1;
          if (quarantine && result.botStats.some(isForcedEnd)) {
            quarantined += 1;
            continue;
          }
          // profileGameFromCapture is in the try too: its contract throws (misaligned capture /
          // seat mismatch) are genuine engine-contract violations and deserve the same coordinates.
          profiles.push(profileGameFromCapture(result, pi, capture));
        } catch (err) {
          // Surface which game blew up rather than dying with a context-free stack far from its
          // cause (this is inside runCount×games×rotations×bots iterations).
          throw new Error(
            `match failed (bot=${bot.name} seed=${seed} rot=${rot}): ${err.message}`,
            {
              cause: err,
            }
          );
        }
      }
    }
    perRun.push(profiles.length ? reduceRun(profiles) : { ...NULL_RUN });
    process.stderr.write(`\r  ${bot.name}: run ${run + 1}/${runCount}`); // in-place progress
  }
  log('');
  return { perRun, played, quarantined };
}

const start = Date.now();
const sweepByBot = new Map(profiled.map(bot => [bot.name, sweepBot(bot)]));
const runsByBot = new Map([...sweepByBot].map(([name, s]) => [name, s.perRun]));
const totalPlayed = [...sweepByBot.values()].reduce((a, s) => a + s.played, 0);
const totalQuarantined = [...sweepByBot.values()].reduce((a, s) => a + s.quarantined, 0);
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
log(
  `\nDone in ${elapsed}s — ${totalPlayed} matches, ${totalQuarantined} quarantined ` +
    `(${totalPlayed ? ((totalQuarantined / totalPlayed) * 100).toFixed(2) : '0.00'}%)\n`
);

// --- Aggregate + compare ---

const controlRuns = runsByBot.get(controlName);
const report = {
  config: {
    runs: runCount,
    games: gamesPerRun,
    rotations: fieldSize,
    stride: STRIDE,
    reference: referenceName,
    control: controlName,
    opponents: opponentNames,
    fieldSize,
    mde, // the (possibly calibrated) per-axis thresholds the signature gate used
    quarantine: {
      on: quarantine,
      rate: totalPlayed ? totalQuarantined / totalPlayed : 0,
      // Per-bot rate (§3.7): a flaky opponent can gut one bot's sample without moving the pool rate.
      ratePerBot: Object.fromEntries(
        [...sweepByBot].map(([name, s]) => [name, s.played ? s.quarantined / s.played : 0])
      ),
    },
  },
  bots: profiled.map(bot => {
    const perRun = runsByBot.get(bot.name);
    const metrics = Object.fromEntries(
      AXES.map(axis => [axis, summarizeAxis(perRun.map(r => r[axis]))])
    );
    const vsControl = bot.name === controlName ? null : compareToControl(perRun, controlRuns);
    // Gate the pre-registered signature when the profiled bot's name names a persona (and it
    // isn't the control). DEFAULT_MDE covers every signature axis, so signatureDetail won't throw.
    const sig = PERSONA_SIGNATURES[bot.name];
    const signature =
      sig && vsControl ? { persona: bot.name, ...signatureDetail(sig, vsControl, mde) } : null;
    return { name: bot.name, metrics, vsControl, signature, liveRuns: liveRunCount(perRun) };
  }),
};

// Holm step-down across the gated signatures (§3.3) — the family-wise confirmatory verdicts.
// Cannot throw here: --holm-family was validated against the gated-persona count pre-sweep.
const gatedSignatures = report.bots
  .filter(b => b.signature)
  .map(b => ({ persona: b.signature.persona, detail: b.signature }));
report.holm = gatedSignatures.length
  ? holmSignatures(gatedSignatures, holmFamily != null ? { familySize: holmFamily } : {})
  : null;

// --- Output ---

if (asJson) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

// A bare value (no ±) means only ONE run contributed to that axis (winners-only sparsity); mark it
// `nN` so it isn't mistaken for a tight CI.
const fmt = m =>
  m == null
    ? '—'
    : m.ci == null
      ? `${m.mean.toFixed(2)} n${m.n}`
      : `${m.mean.toFixed(2)}±${m.ci.toFixed(2)}`;
const headline = ['winPct', 'aggression', 'avgDiceReserve', 'kills', 'turnsToWin', 'avgPlacement'];

// Flag any bot whose sample was reduced by quarantine, so a low-n result isn't read as robust.
for (const b of report.bots) {
  const rate = report.config.quarantine.ratePerBot[b.name] ?? 0;
  if (b.liveRuns === 0) {
    log(
      `  WARNING: ${b.name} — all ${runCount} runs fully quarantined ` +
        `(${(rate * 100).toFixed(1)}% of games); no behavioral data.`
    );
  } else if (b.liveRuns < runCount) {
    log(
      `  NOTE: ${b.name} — only ${b.liveRuns}/${runCount} runs carry data ` +
        `(quarantine ${(rate * 100).toFixed(1)}%).`
    );
  } else if (rate > 0.1) {
    log(`  NOTE: ${b.name} — quarantine rate ${(rate * 100).toFixed(1)}% (sample reduced).`);
  }
}
log('');

log(['Bot'.padEnd(14), ...headline.map(h => h.padStart(16))].join(''));
log('-'.repeat(14 + headline.length * 16));
for (const b of report.bots) {
  log([b.name.padEnd(14), ...headline.map(h => fmt(b.metrics[h]).padStart(16))].join(''));
}
log('');
for (const b of report.bots) {
  if (!b.vsControl) continue;
  // Distinguish "measured, no difference" from "no data to compare" — both used to print the same
  // "no axis differs" line, hiding a failed measurement as a real null result.
  const comparable = AXES.filter(a => b.vsControl[a]);
  if (comparable.length === 0) {
    log(
      `${b.name} vs ${controlName}: NO COMPARABLE DATA (insufficient paired runs after quarantine)`
    );
    continue;
  }
  const moved = comparable
    .filter(a => b.vsControl[a].verdict !== 'SAME')
    .map(a => {
      const c = b.vsControl[a];
      const nNote = c.n < runCount ? ` n${c.n}` : ''; // paired n below full run count
      return `${a} ${c.verdict} (Δ${c.delta.toFixed(2)}${nNote})`;
    });
  const minN = Math.min(...comparable.map(a => b.vsControl[a].n));
  const dataNote = minN < runCount ? ` [min paired n=${minN}/${runCount}]` : '';
  log(
    `${b.name} vs ${controlName}: ${moved.length ? moved.join(', ') : 'no axis differs'}${dataNote}`
  );
}

// --- Pre-registered persona signature verdicts (the "ships when distinct" gate, §3.2/§3.3) ---
const fmtP = p => (p < 1e-3 ? p.toExponential(1) : p.toFixed(4));
const signed = report.bots.filter(b => b.signature);
if (signed.length) {
  log('');
  for (const b of signed) {
    const s = b.signature;
    const detail = s.axes
      .map(a => {
        const dir = a.direction === 'HIGHER' ? '↑' : '↓';
        if (a.delta == null) return `${a.axis}${dir} no data`;
        // Why this axis did/didn't pass: sub-MDE vs not-significant vs both-clear (ok).
        const why = a.ok ? 'ok' : !a.meetsMde ? `|Δ|<MDE(${a.mde})` : 'CI∌0';
        return `${a.axis}${dir} Δ${a.delta.toFixed(2)} [${a.lo.toFixed(2)},${a.hi.toFixed(2)}] p=${fmtP(a.p)} ${why}`;
      })
      .join('; ');
    log(
      `${s.persona} signature (${s.rule}) vs ${controlName}: ${s.pass ? 'PASS ✓' : 'FAIL ✗'} — ${detail}`
    );
  }

  // The family-wise verdicts (§3.3): the per-persona PASS above is the registered single-test
  // gate; a persona is CONFIRMED only if it also survives the Holm step-down across the family.
  const h = report.holm;
  log('');
  log(
    `Holm confirmatory family: m=${h.familySize}` +
      `${holmFamily == null ? ' (registered, PERSONA_SIGNATURES)' : ' (--holm-family)'}, ` +
      `one-sided α=${h.alpha}`
  );
  for (const r of h.results) {
    if (r.p == null) {
      log(`  ${r.persona}: no p (a signature axis has no comparable data) → NOT CONFIRMED`);
      continue;
    }
    log(
      `  ${r.persona}: p=${fmtP(r.p)} → pAdj=${fmtP(r.pAdj)} ` +
        `(rank ${r.rank}, threshold ${fmtP(r.threshold)}) Holm ${r.holmReject ? '✓' : '✗'} · ` +
        `single-test ${r.unadjustedPass ? '✓' : '✗'} → ` +
        `${r.confirmatoryPass ? 'CONFIRMED ✓' : 'NOT CONFIRMED ✗'}`
    );
  }
}
