"""Behavioral-cloning trainer for the DiceWarsJS ml-bot (Phase 2).

Clones the strongest heuristic bot (``ai_lookahead``) from a packed self-play
tensor corpus produced by ``scripts/encode-corpus.mjs`` (the JS side, per the
D-Encoding contract in ``docs/ml-bot/DECISIONS.md``), then exports the policy to
ONNX for in-browser inference via ONNX Runtime Web (D-4).

Pipeline (all upstream of this package lives in the JS repo):

    selfplay.mjs      → lean JSONL corpus (seed + action list + terminal labels)
    encode-corpus.mjs → packed little-endian tensors + manifest.json   ← this package reads these
    dicewars_bc       → train a masked per-edge MLP, export ONNX
    (next slice)      → src/ai ONNX-Runtime-Web bot wrapping the exported model

The on-disk tensor layout (shapes, dtypes, CSR edge layout, feature-column
order) is described by the corpus ``manifest.json`` and mirrored by
:data:`dicewars_bc.manifest.EXPECTED_ENCODING_VERSION`.
"""

from .manifest import EXPECTED_ENCODING_VERSION, CorpusManifest, load_manifest

__all__ = ["CorpusManifest", "EXPECTED_ENCODING_VERSION", "load_manifest"]
