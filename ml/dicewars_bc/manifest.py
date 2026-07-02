"""Load + validate a packed-corpus ``manifest.json``.

The manifest is written by ``scripts/encode-corpus.mjs`` and is the single
source of truth for the on-disk tensor layout: dtypes, shapes, the CSR edge
layout, and the feature-column order. This module turns it into a typed object
and fails loudly on the two ways it could silently poison training:

* an **encoding-version mismatch** — the JS encoder bumped ``ENCODING_VERSION``
  (a feature column moved/changed) but the trainer wasn't updated, so every
  tensor would be mis-interpreted column-for-column;
* a **missing or malformed file/shape entry** — a blob the loader will
  ``np.fromfile(...).reshape(...)`` is absent or its declared shape is
  inconsistent (e.g. the CSR ``edge_offsets`` length ≠ ``steps + 1``).

Keeping this strict here means the rest of the package can trust the shapes.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

# Must match `ENCODING_VERSION` in src/arena/encodeObservation.js. Bump in
# lockstep when the feature layout changes incompatibly.
# v2 (ml-bot Phase-3, D-18): +3 node neighbourhood feats (5→8), +3 edge
# attack-consequence feats (4→7). v3 (D-31, append-only): owner-attribute /
# income-consequence node feats (8→13), turn-order player feat (6→7), stock/clock
# board feats (5→7), elimination/income edge feats (7→10). Model/dataset read
# widths from the manifest dims, so no code dims change — only this guard + the
# corpus must agree. NB: bumping this orphans older corpora for TRAINING (re-encode
# from the lean JSONL if needed); the JS inference side keeps running v2-stamped
# WEIGHTS via its SUPPORTED_ENCODING_VERSIONS slice-compat.
EXPECTED_ENCODING_VERSION = 3

# The packed blobs the trainer consumes, with their expected dtype string.
# (Matches manifest.files written by scripts/encode-corpus.mjs.)
_REQUIRED_FILES: dict[str, str] = {
    "nodes.f32": "<f4",
    "players.f32": "<f4",
    "board.f32": "<f4",
    "edges.f32": "<f4",
    "edge_index.i32": "<i4",
    "edge_offsets.i32": "<i4",
    "labels.i32": "<i4",
    "value.f32": "<f4",
    "meta.i32": "<i4",
}


@dataclass(frozen=True)
class CorpusManifest:
    """A validated view of a packed-corpus ``manifest.json``."""

    root: Path
    raw: dict

    # --- dims (from manifest.dims) ---
    max_areas: int
    player_count: int
    node_features: int
    player_features: int
    board_features: int
    edge_features: int

    # --- counts (from manifest.counts) ---
    steps: int
    total_edges: int
    games: int

    encoding_version: int
    teacher: str

    def file_path(self, name: str) -> Path:
        return self.root / name

    def shape(self, name: str) -> tuple[int, ...]:
        return tuple(self.raw["files"][name]["shape"])

    def dtype(self, name: str) -> str:
        return self.raw["files"][name]["dtype"]

    @property
    def feature_names(self) -> dict[str, list[str]]:
        return self.raw["featureNames"]

    def __repr__(self) -> str:  # pragma: no cover - cosmetic
        return (
            f"CorpusManifest(teacher={self.teacher!r}, steps={self.steps}, "
            f"total_edges={self.total_edges}, nodes={self.max_areas}x{self.node_features}, "
            f"players={self.player_count}x{self.player_features})"
        )


def load_manifest(corpus_dir: str | Path) -> CorpusManifest:
    """Load + validate ``<corpus_dir>/manifest.json``.

    Raises:
        FileNotFoundError: the directory or manifest is missing.
        ValueError: encoding-version mismatch, a missing/mis-typed blob, or a
            shape that contradicts the declared dims/counts.
    """
    root = Path(corpus_dir)
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(
            f"No manifest.json in {root} — point --corpus at a directory produced by "
            f"`npm run encode-corpus` (the tensor-expansion pass)."
        )

    raw = json.loads(manifest_path.read_text())

    version = raw.get("encodingVersion")
    if version != EXPECTED_ENCODING_VERSION:
        raise ValueError(
            f"Encoding-version mismatch: corpus is v{version}, trainer expects "
            f"v{EXPECTED_ENCODING_VERSION}. The JS encoder (src/arena/encodeObservation.js) "
            f"changed the feature layout — update dicewars_bc.manifest.EXPECTED_ENCODING_VERSION "
            f"and the dataset/model column assumptions together."
        )

    dims = raw["dims"]
    counts = raw["counts"]

    manifest = CorpusManifest(
        root=root,
        raw=raw,
        max_areas=dims["maxAreas"],
        player_count=dims["playerCount"],
        node_features=dims["nodeFeatures"],
        player_features=dims["playerFeatures"],
        board_features=dims["boardFeatures"],
        edge_features=dims["edgeFeatures"],
        steps=counts["steps"],
        total_edges=counts["totalEdges"],
        games=counts["games"],
        encoding_version=version,
        teacher=raw.get("teacher", "?"),
    )

    _validate_files(manifest)
    return manifest


def _validate_files(m: CorpusManifest) -> None:
    """Assert every required blob exists, has the expected dtype, and a shape
    consistent with the declared dims/counts. A drift here would otherwise
    surface as a silent ``reshape`` mis-interpretation downstream."""
    files = m.raw.get("files", {})

    expected_shapes: dict[str, tuple[int, ...]] = {
        "nodes.f32": (m.steps, m.max_areas, m.node_features),
        "players.f32": (m.steps, m.player_count, m.player_features),
        "board.f32": (m.steps, m.board_features),
        "edges.f32": (m.total_edges, m.edge_features),
        "edge_index.i32": (m.total_edges, 2),
        "edge_offsets.i32": (m.steps + 1,),
        "labels.i32": (m.steps,),
        "value.f32": (m.steps, 2),
        "meta.i32": (m.steps, 3),
    }

    for name, dtype in _REQUIRED_FILES.items():
        if name not in files:
            raise ValueError(f"manifest.files is missing required blob '{name}'.")
        if files[name].get("dtype") != dtype:
            raise ValueError(
                f"Blob '{name}' has dtype {files[name].get('dtype')!r}, expected {dtype!r}. "
                f"The trainer assumes little-endian f4/i4 (see encode-corpus.mjs)."
            )
        declared = tuple(files[name]["shape"])
        if declared != expected_shapes[name]:
            raise ValueError(
                f"Blob '{name}' shape {declared} contradicts the declared dims/counts "
                f"{expected_shapes[name]} — manifest is internally inconsistent."
            )
        path = m.file_path(name)
        if not path.is_file():
            raise FileNotFoundError(f"Corpus blob '{name}' not found at {path}.")
