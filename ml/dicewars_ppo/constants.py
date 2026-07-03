"""The Node↔Python wire/encoding contract, mirrored on the Python side.

These constants MUST agree with the JS encoder. The single sources of truth are:

* feature columns + ``ENCODING_VERSION`` — ``src/arena/encodeObservation.js``
  (the same arrays ``dicewars_bc`` reads from a corpus ``manifest.json``);
* the binary frame layout — ``scripts/lib/obs-frame.mjs``;
* ``MAX_EDGES`` — DECISIONS [D-20] (validated p100 ≈ 26 → 64 with margin).

A socket frame is self-describing for its *dims* (``maxAreas``/``playerCount``/
``numEdges`` ride in the header) but NOT for its *feature widths* — those are
implicit, exactly as the offline corpus relies on ``manifest.featureNames``. So
this module pins the current-encoding widths and the parser guards ``encodingVersion`` against
``ENCODING_VERSION`` on every frame. Bump both sides in lockstep on a v-change
(the same lockstep ``dicewars_bc.manifest.EXPECTED_ENCODING_VERSION`` documents).
"""

from __future__ import annotations

import struct

# --- encoding version (lockstep with src/arena/encodeObservation.js) ---------

# v2 (ml-bot Phase-3, [D-18]): node 5→8 (+3 neighbourhood feats), edge 4→7
# (+3 attack-consequence feats). v3 ([D-31], append-only): node 8→13 (owner
# attributes + income consequences), player 6→7 (+turn order), board 5→7
# (+stock/clock), edge 7→10 (+elimination/income deltas). The v2 columns are an
# exact PREFIX of v3. Bump here AND in encodeObservation.js together.
ENCODING_VERSION = 3

# --- feature columns, in tensor-column order (mirror encodeObservation.js) ----

NODE_FEATURES: tuple[str, ...] = (
    "present",
    "diceNorm",
    "isMine",
    "isEnemy",
    "isBorder",
    "enemyNbrDiceMaxNorm",  # v2
    "enemyNbrFrac",  # v2
    "degreeNorm",  # v2
    "ownerTerrFrac",  # v3
    "ownerIncomeFrac",  # v3
    "ownerDiceFrac",  # v3
    "cutValueNorm",  # v3
    "myGainIfCapturedNorm",  # v3
)
PLAYER_FEATURES: tuple[str, ...] = (
    "isMe",
    "eliminated",
    "territoriesFrac",
    "diceFrac",
    "connectedFrac",
    "stockNorm",
    "turnsUntilActsNorm",  # v3
)
BOARD_FEATURES: tuple[str, ...] = (
    "myDiceShare",
    "activeFrac",
    "phaseEarly",
    "phaseMid",
    "phaseLate",
    "myStockNorm",  # v3
    "turnNumberNorm",  # v3
)
EDGE_FEATURES: tuple[str, ...] = (
    "winProb",
    "atkNorm",
    "defNorm",
    "isStop",
    "tgtRetakeThreatNorm",  # v2
    "srcVacateThreatNorm",  # v2
    "tgtEnemyNbrFrac",  # v2
    "eliminatesDefender",  # v3
    "defIncomeDeltaNorm",  # v3
    "myIncomeDeltaNorm",  # v3
)

NODE_W = len(NODE_FEATURES)  # 13
PLAYER_W = len(PLAYER_FEATURES)  # 7
BOARD_W = len(BOARD_FEATURES)  # 7
EDGE_W = len(EDGE_FEATURES)  # 10

# --- action space -------------------------------------------------------------

# Fixed Discrete action-space size for MaskablePPO. A live decision has
# `numEdges` legal entries (legal attacks + 1 STOP); the env pads to MAX_EDGES
# and masks the [numEdges, MAX_EDGES) tail. [D-20]: observed per-decision p100 ≈
# 26 over ~100k decisions, zero overflow → 64 gives ~2.5× margin and is well
# under sb3-contrib #247's ~1400-action sparse-mask crash zone.
MAX_EDGES = 64

# --- engine defaults (overridable per-env / per-server) -----------------------

# DEFAULT_AREA_MAX in the engine (id 0 is the unused sentinel → ≤31 real nodes).
# The env-server defaults `--max-areas` to BC_POLICY.config.maxAreas (= 32).
DEFAULT_MAX_AREAS = 32
DEFAULT_PLAYER_COUNT = 7

# --- binary frame header (mirror scripts/lib/obs-frame.mjs) -------------------

# ASCII "DWOB" as a little-endian i32 (== struct '<i' of the bytes b"BOWD").
OBS_FRAME_MAGIC = 0x44574F42

# 12 header fields × 4 bytes: 11 × i32 then 1 × f32 (placement). The 11th i32 is
# `truncated` (1 = maxTurns stalemate cap → Gym truncation, else 0), inserted before
# placement to disambiguate a cap survivor from a winner=-1 mid-game elimination.
# See obs-frame.mjs.
HEADER_STRUCT = struct.Struct("<11if")
HEADER_BYTES = HEADER_STRUCT.size  # 48
assert HEADER_BYTES == 48, "header layout drifted from obs-frame.mjs"

# Shaped-header variant ("bite G", docs/ml-bot/PERSONAS.md §2/§8): the base header plus two
# RAW per-step reward measurements the env-server emits ONLY under `--reward-shaping` —
# `deltaTerritory` (f32, net learner-territory change since the prior decision) then
# `elimsByLearner` (i32, learner-attributed eliminations since the prior decision). Off by
# default ⇒ a frame is byte-identical to today. This is a WIRE-FRAME variant, NOT an
# observation-layout change: the tensor payload (and thus the policy net's input) is identical,
# so it is deliberately NOT gated by ENCODING_VERSION — the warm-start/weights guards stay valid.
# The Python consumer (wire.parse_frame) and the JS emitter (obs-frame.mjs) must change together.
HEADER_STRUCT_SHAPED = struct.Struct("<11iffi")
HEADER_BYTES_SHAPED = HEADER_STRUCT_SHAPED.size  # 56
assert HEADER_BYTES_SHAPED == 56, "shaped header layout drifted from obs-frame.mjs"

# Little-endian dtype strings for the tensor payload (matches the corpus blobs).
F32 = "<f4"
I32 = "<i4"
