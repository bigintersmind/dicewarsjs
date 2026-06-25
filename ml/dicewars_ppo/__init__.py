"""``dicewars_ppo`` — the self-play PPO side of the DiceWarsJS ml-bot (Phase 3).

This package is the **Python learner** that trains against the in-process Node
self-play env-server (``scripts/ppo-env-server.mjs``). It is the sibling of
``dicewars_bc`` (the Phase-2 behavioral-cloning trainer) and deliberately reuses
its ``EdgePolicyNet`` as the PPO policy trunk — see DECISIONS [D-19].

Layout (built incrementally over Phase-3 tracer steps 4–7, see
``../../docs/ml-bot/PLAN.md``):

* ``constants`` — the wire/encoding contract shared with the JS side (feature
  widths, ``ENCODING_VERSION`` guard, ``MAX_EDGES``).
* ``wire`` — the binary observation-frame codec: a Python port of
  ``scripts/lib/obs-frame.mjs`` plus the length-prefixed socket framing.
* ``env_server`` — launch + supervise a ``ppo-env-server.mjs`` subprocess.
* ``env`` — ``DiceWarsEnv``, a single-agent Gymnasium env over the socket
  (Discrete(``MAX_EDGES``) + action masking). **Step 4 (this scaffold).**
* ``policy`` / training entry — step 5–6 (not built yet).

**Why single-agent, not PettingZoo AEC.** The underlying game is an 8-way AEC,
but the env-server runs all opponent seats *in-process in Node* and exposes only
the single learner seat to Python. So the Python-facing interface is a standard
single-agent ``gymnasium.Env`` with an ``action_masks()`` method — exactly what
sb3-contrib ``MaskablePPO`` consumes — and no multi-agent wrapper is needed. This
holds for the whole of Phase 3: even the PFSP league ([D-19]) runs frozen
snapshots as in-process JS bots, so there is never more than one external seat.
"""

from .constants import ENCODING_VERSION, MAX_EDGES

__all__ = ["ENCODING_VERSION", "MAX_EDGES"]
