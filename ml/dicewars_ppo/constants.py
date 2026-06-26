"""The Node↔Python wire/encoding contract, mirrored on the Python side.

These constants MUST agree with the JS encoder. The single sources of truth are:

* feature columns + ``ENCODING_VERSION`` — ``src/arena/encodeObservation.js``
  (the same arrays ``dicewars_bc`` reads from a corpus ``manifest.json``);
* the binary frame layout — ``scripts/lib/obs-frame.mjs``;
* ``MAX_EDGES`` — DECISIONS [D-20] (validated p100 ≈ 26 → 64 with margin).

A socket frame is self-describing for its *dims* (``maxAreas``/``playerCount``/
``numEdges`` ride in the header) but NOT for its *feature widths* — those are
implicit, exactly as the offline corpus relies on ``manifest.featureNames``. So
this module pins the v2 widths and the parser guards ``encodingVersion`` against
``ENCODING_VERSION`` on every frame. Bump both sides in lockstep on a v-change
(the same lockstep ``dicewars_bc.manifest.EXPECTED_ENCODING_VERSION`` documents).
"""

from __future__ import annotations

import struct

# --- encoding version (lockstep with src/arena/encodeObservation.js) ---------

# v2 (ml-bot Phase-3, [D-18]): node 5→8 (+3 neighbourhood feats), edge 4→7
# (+3 attack-consequence feats). Bump here AND in encodeObservation.js together.
ENCODING_VERSION = 2

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
)
PLAYER_FEATURES: tuple[str, ...] = (
    "isMe",
    "eliminated",
    "territoriesFrac",
    "diceFrac",
    "connectedFrac",
    "stockNorm",
)
BOARD_FEATURES: tuple[str, ...] = (
    "myDiceShare",
    "activeFrac",
    "phaseEarly",
    "phaseMid",
    "phaseLate",
)
EDGE_FEATURES: tuple[str, ...] = (
    "winProb",
    "atkNorm",
    "defNorm",
    "isStop",
    "tgtRetakeThreatNorm",  # v2
    "srcVacateThreatNorm",  # v2
    "tgtEnemyNbrFrac",  # v2
)

NODE_W = len(NODE_FEATURES)  # 8
PLAYER_W = len(PLAYER_FEATURES)  # 6
BOARD_W = len(BOARD_FEATURES)  # 5
EDGE_W = len(EDGE_FEATURES)  # 7

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

# Little-endian dtype strings for the tensor payload (matches the corpus blobs).
F32 = "<f4"
I32 = "<i4"
