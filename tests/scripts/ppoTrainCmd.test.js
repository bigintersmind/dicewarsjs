/**
 * Windows→WSL env forwarding in the schtasks bridge (`scripts/shodan/ppo-train.cmd`).
 *
 * The regression guard for the #105 bug class: a per-run knob added to ppo-train.sh but
 * never forwarded through WSLENV silently falls back to its launcher default inside WSL —
 * the scheduled task *looks* configured (the Windows env var is set) while the run trains
 * a different regime. Static text checks only (cmd.exe can't run here); the bash-side
 * behavior is pinned by ml/tests/test_ppo_train_launcher.py.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CMD = resolve(here, '../../scripts/shodan/ppo-train.cmd');
const cmdText = readFileSync(CMD, 'utf8');

// Every per-run knob ppo-train.sh reads from the environment — the vars its build_train_argv
// forwards to `python -m dicewars_ppo.train` plus the run-identity/mode vars its main() launch
// log records (PERSONA/RUN_NAME/FROM_SCRATCH). Deliberately hardcoded (parsing bash from JS is
// brittle): adding a knob to build_train_argv means adding it BOTH to the .cmd's WSLENV list
// and here. Machine-local vars (paths under RUN_ROOT, DEVICE, backoff policy) stay WSL-side.
const PER_RUN_KNOBS = [
  'PERSONA',
  'CHECKPOINT',
  'TIMESTEPS',
  'LR',
  'ENT_COEF',
  'GAMMA',
  'RUN_NAME',
  'REWARD_MODE',
  'TERMINAL_SPEED_BONUS',
  'SPEED_REF',
  'TERRITORY_REWARD_COEF',
  'ELIM_BOUNTY',
  'SHAPING_CLIP',
  'N_ENVS',
  'RESERVE_BASELINES',
  'FROM_SCRATCH',
];

/**
 * Extract the forwarded-variable name list from one `set "WSLENV=…"` value: strip the
 * append-mode `%WSLENV%:` prefix, split the `NAME/u:NAME/u:…` chain, drop the `/u`
 * direction flags. Throws on a token without `/u` — every entry must carry the Win32→WSL
 * direction flag or it silently doesn't cross the boundary.
 */
function parseWslenvList(value) {
  const chain = value.replace(/^%WSLENV%:/, '');
  return chain.split(':').map(token => {
    if (!/^[A-Z0-9_]+\/u$/.test(token)) {
      throw new Error(`WSLENV token "${token}" is not a NAME/u (Win32→WSL) entry`);
    }
    return token.slice(0, -'/u'.length);
  });
}

describe('ppo-train.cmd WSLENV forwarding', () => {
  // The list is duplicated across the empty-WSLENV and append-to-WSLENV branches of the
  // `if "%WSLENV%"==""` set — capture both.
  const lists = [...cmdText.matchAll(/set "WSLENV=([^"]+)"/g)].map(m => parseWslenvList(m[1]));

  it('defines the list in both set branches', () => {
    expect(lists).toHaveLength(2);
  });

  it('keeps the two branch lists identical', () => {
    expect(lists[1]).toEqual(lists[0]);
  });

  it('forwards every per-run knob build_train_argv reads (incl. FROM_SCRATCH — the #105 bug)', () => {
    for (const list of lists) {
      for (const knob of PER_RUN_KNOBS) {
        expect(list).toContain(knob);
      }
    }
  });
});
