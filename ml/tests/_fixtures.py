"""Build a tiny, valid packed corpus on disk for hermetic tests.

Mirrors exactly what ``scripts/encode-corpus.mjs`` writes (little-endian
f4/i4 blobs + manifest.json, CSR edge layout) so the loader/model are exercised
against the real on-disk contract — just at toy dims. No real corpus (which is
gitignored under data/selfplay/) is required.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

# Feature widths are part of the encoding contract — keep these at the real
# widths so the model code paths are identical to production; only A and P shrink.
# v2 (ml-bot Phase-3, D-18): node 5→8 (+neighbourhood feats), edge 4→7 (+consequence
# feats); isStop stays column 3. v3 (D-31, append-only): node 8→13, player 6→7,
# board 5→7, edge 7→10. Mirror src/arena/encodeObservation.js.
NODE_FEATURES = [
    "present", "diceNorm", "isMine", "isEnemy", "isBorder",
    "enemyNbrDiceMaxNorm", "enemyNbrFrac", "degreeNorm",
    "ownerTerrFrac", "ownerIncomeFrac", "ownerDiceFrac",
    "cutValueNorm", "myGainIfCapturedNorm",
]
PLAYER_FEATURES = [
    "isMe", "eliminated", "territoriesFrac", "diceFrac", "connectedFrac", "stockNorm",
    "turnsUntilActsNorm",
]
BOARD_FEATURES = [
    "myDiceShare", "activeFrac", "phaseEarly", "phaseMid", "phaseLate",
    "myStockNorm", "turnNumberNorm",
]
EDGE_FEATURES = [
    "winProb", "atkNorm", "defNorm", "isStop",
    "tgtRetakeThreatNorm", "srcVacateThreatNorm", "tgtEnemyNbrFrac",
    "eliminatesDefender", "defIncomeDeltaNorm", "myIncomeDeltaNorm",
]


def make_step(
    *, game: int, player: int, turn: int, max_areas: int, player_count: int, edge_count: int,
    label: int, won: float = 1.0, placement: float = 1.0, seed: int = 0,
) -> dict:
    """One structurally valid step. ``edge_count`` includes the trailing STOP."""
    rng = np.random.default_rng(seed)
    nodes = rng.random((max_areas, len(NODE_FEATURES))).astype("<f4")
    # present-mask: node 0 is the absent sentinel; mark a subset present.
    nodes[:, 0] = (rng.random(max_areas) > 0.3).astype("<f4")
    nodes[0, :] = 0.0  # sentinel id 0 all-zero (absent)

    players = rng.random((player_count, len(PLAYER_FEATURES))).astype("<f4")
    players[:, 0] = 0.0
    players[player % player_count, 0] = 1.0  # isMe one seat

    board = rng.random(len(BOARD_FEATURES)).astype("<f4")

    edges = rng.random((edge_count, len(EDGE_FEATURES))).astype("<f4")
    edges[-1] = 0.0  # STOP edge: all features 0 ...
    edges[-1, 3] = 1.0  # ... except isStop (column 3, width-agnostic)
    edges[:-1, 3] = 0.0  # attacks have isStop=0

    edge_index = np.zeros((edge_count, 2), dtype="<i4")
    # attacks reference in-range real ids [1, max_areas); STOP → (0, 0).
    edge_index[:-1, 0] = rng.integers(1, max_areas, edge_count - 1)
    edge_index[:-1, 1] = rng.integers(1, max_areas, edge_count - 1)

    assert 0 <= label < edge_count
    return {
        "game": game,
        "player": player,
        "turn": turn,
        "nodes": nodes,
        "players": players,
        "board": board,
        "edges": edges,
        "edge_index": edge_index,
        "label": label,
        "value": np.array([won, placement], dtype="<f4"),
    }


def write_corpus(
    out_dir: str | Path, steps: list[dict], *, teacher: str = "Lookahead", encoding_version: int = 3
) -> Path:
    """Pack ``steps`` into the on-disk blob/manifest layout. Returns the dir."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    max_areas = steps[0]["nodes"].shape[0]
    player_count = steps[0]["players"].shape[0]
    n_steps = len(steps)

    nodes = np.stack([s["nodes"] for s in steps]).astype("<f4")
    players = np.stack([s["players"] for s in steps]).astype("<f4")
    board = np.stack([s["board"] for s in steps]).astype("<f4")
    value = np.stack([s["value"] for s in steps]).astype("<f4")
    labels = np.array([s["label"] for s in steps], dtype="<i4")
    meta = np.array([[s["game"], s["player"], s["turn"]] for s in steps], dtype="<i4")

    edges = np.concatenate([s["edges"] for s in steps]).astype("<f4")
    edge_index = np.concatenate([s["edge_index"] for s in steps]).astype("<i4")
    counts = [s["edges"].shape[0] for s in steps]
    edge_offsets = np.zeros(n_steps + 1, dtype="<i4")
    edge_offsets[1:] = np.cumsum(counts)
    total_edges = int(edge_offsets[-1])

    blobs = {
        "nodes.f32": nodes,
        "players.f32": players,
        "board.f32": board,
        "edges.f32": edges,
        "edge_index.i32": edge_index,
        "edge_offsets.i32": edge_offsets,
        "labels.i32": labels,
        "value.f32": value,
        "meta.i32": meta,
    }
    for name, arr in blobs.items():
        arr.tofile(out / name)

    manifest = {
        "encodingVersion": encoding_version,
        "observationSchemaVersion": 1,
        "source": "synthetic.jsonl",
        "teacher": teacher,
        "counts": {
            "games": len({s["game"] for s in steps}),
            "gamesWithTeacher": len({s["game"] for s in steps}),
            "steps": n_steps,
            "totalEdges": total_edges,
        },
        "dims": {
            "maxAreas": max_areas,
            "playerCount": player_count,
            "nodeFeatures": len(NODE_FEATURES),
            "playerFeatures": len(PLAYER_FEATURES),
            "boardFeatures": len(BOARD_FEATURES),
            "edgeFeatures": len(EDGE_FEATURES),
        },
        "featureNames": {
            "node": NODE_FEATURES,
            "player": PLAYER_FEATURES,
            "board": BOARD_FEATURES,
            "edge": EDGE_FEATURES,
        },
        "byteOrder": "little-endian",
        "files": {
            "nodes.f32": {"dtype": "<f4", "shape": [n_steps, max_areas, len(NODE_FEATURES)]},
            "players.f32": {"dtype": "<f4", "shape": [n_steps, player_count, len(PLAYER_FEATURES)]},
            "board.f32": {"dtype": "<f4", "shape": [n_steps, len(BOARD_FEATURES)]},
            "edges.f32": {"dtype": "<f4", "shape": [total_edges, len(EDGE_FEATURES)]},
            "edge_index.i32": {"dtype": "<i4", "shape": [total_edges, 2]},
            "edge_offsets.i32": {"dtype": "<i4", "shape": [n_steps + 1]},
            "labels.i32": {"dtype": "<i4", "shape": [n_steps]},
            "value.f32": {"dtype": "<f4", "shape": [n_steps, 2]},
            "meta.i32": {"dtype": "<i4", "shape": [n_steps, 3]},
        },
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return out


def default_corpus(out_dir: str | Path, max_areas: int = 6, player_count: int = 2) -> Path:
    """A small multi-game corpus: 3 games × a few steps, varied edge counts."""
    steps = []
    specs = [
        # (game, player, turn, edge_count, label)
        (0, 0, 1, 3, 0),
        (0, 0, 2, 5, 4),  # label = STOP (last)
        (0, 0, 3, 2, 1),
        (1, 0, 1, 4, 2),
        (1, 0, 2, 6, 0),
        (2, 0, 1, 3, 2),
        (2, 0, 2, 4, 3),
    ]
    for i, (game, player, turn, ec, label) in enumerate(specs):
        steps.append(
            make_step(
                game=game, player=player, turn=turn, max_areas=max_areas,
                player_count=player_count, edge_count=ec, label=label, seed=i,
            )
        )
    return write_corpus(out_dir, steps)
