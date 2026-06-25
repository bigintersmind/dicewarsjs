"""Export a trained BC checkpoint to a plain-JS weights module for the in-browser bot.

    python -m dicewars_bc.export_weights --ckpt checkpoints/bc_model.pt \
        --out ../src/ai/bcPolicyWeights.js

The in-browser bot runs the policy with a hand-written **synchronous** forward pass
(``src/ai/bcForward.js``) rather than ONNX Runtime Web, because the bot contract
``(BotState) -> {from,to}|null`` is synchronous everywhere in the arena while ORT's
``session.run`` is async. For this tiny per-edge MLP a pure-JS forward is trivially
fast, needs no WASM bundle, and keeps the sync contract. The ONNX export remains the
canonical numeric reference the JS forward is cross-checked against (see the
JS↔Python parity fixture/tests).

This writes a ``.js`` module (not ``.json``) so it imports identically in the Vite
browser bundle, the Node arena CLI (`node scripts/arena.mjs`), and Vitest — none of
which need JSON import attributes that way. Each ``nn.Linear`` becomes ``{w, b, relu}``
where ``w`` is the PyTorch ``[out, in]`` weight, ``b`` the ``[out]`` bias, and ``relu``
whether a ReLU follows it in that MLP.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from torch import nn

from .model import EdgePolicyNet, ModelConfig

# The five Sequential MLPs of EdgePolicyNet, mapped to camelCase keys the JS reads.
_HEADS = {
    "nodeEncoder": "node_encoder",
    "playerEncoder": "player_encoder",
    "context": "context",
    "edgeHead": "edge_head",
    "valueHead": "value_head",
}


def _dump_mlp(seq: nn.Sequential) -> list[dict]:
    """A Sequential of Linear/ReLU → a list of ``{w, b, relu}`` layers.

    ``relu`` marks whether the very next module in the Sequential is a ReLU, so the
    JS forward applies the exact same nonlinearity pattern (``_mlp`` puts a ReLU
    after every Linear except the last)."""
    children = list(seq.children())
    layers = []
    for i, mod in enumerate(children):
        if not isinstance(mod, nn.Linear):
            continue
        relu = i + 1 < len(children) and isinstance(children[i + 1], nn.ReLU)
        layers.append(
            {
                "w": mod.weight.detach().cpu().tolist(),  # [out, in]
                "b": mod.bias.detach().cpu().tolist(),  # [out]
                "relu": relu,
            }
        )
    return layers


def _make_fixture(
    model: EdgePolicyNet, config: ModelConfig, n_cases: int = 6, seed: int = 0
) -> dict:
    """Reference (input → logits/value) cases the JS forward is cross-checked against.

    Random but structurally valid single steps (present-mask, in-range ids, a trailing
    STOP edge), run through the *same* loaded model — so the fixture is always
    consistent with the weights emitted alongside it. The JS parity test replays each
    case through ``bcForward.js`` and asserts it reproduces these logits."""
    g = torch.Generator().manual_seed(seed)
    a = config.max_areas
    cases = []
    for _ in range(n_cases):
        p = int(torch.randint(2, 8, (1,), generator=g).item())
        n_attacks = int(torch.randint(0, 6, (1,), generator=g).item())
        e = n_attacks + 1  # + trailing STOP

        nodes = torch.rand(1, a, config.node_features, generator=g)
        nodes[0, :, EdgePolicyNet.PRESENT_COL] = (torch.rand(a, generator=g) > 0.3).float()
        nodes[0, 0, :] = 0.0  # sentinel id 0 absent
        players = torch.rand(1, p, config.player_features, generator=g)
        board = torch.rand(1, config.board_features, generator=g)

        edge_feat = torch.rand(e, config.edge_features, generator=g)
        edge_from = torch.randint(1, a, (e,), generator=g)
        edge_to = torch.randint(1, a, (e,), generator=g)
        edge_feat[-1] = 0.0  # STOP edge: zero all features ...
        edge_feat[-1, 3] = 1.0  # ... except isStop (column 3; width-agnostic across encoding versions)
        edge_from[-1] = 0
        edge_to[-1] = 0
        edge_batch = torch.zeros(e, dtype=torch.int64)

        with torch.no_grad():
            logits, value = model(nodes, players, board, edge_feat, edge_from, edge_to, edge_batch)

        cases.append(
            {
                "nodes": nodes[0].tolist(),
                "players": players[0].tolist(),
                "board": board[0].tolist(),
                "edges": edge_feat.tolist(),
                "edgeIndex": torch.stack([edge_from, edge_to], dim=1).tolist(),
                "logits": logits.tolist(),
                "value": value[0].tolist(),
            }
        )
    return {"seed": seed, "cases": cases}


def export(
    ckpt_path: str | Path, out_path: str | Path, fixture_path: str | Path | None = None
) -> Path:
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    config = ModelConfig(**ckpt["config"])
    model = EdgePolicyNet(config)
    model.load_state_dict(ckpt["state_dict"])
    model.eval()

    payload = {
        "encodingVersion": ckpt.get("encoding_version"),
        "teacher": ckpt.get("teacher"),
        "selectionMetric": ckpt.get("selection_metric"),
        "selectionAccuracy": ckpt.get("selection_accuracy"),
        # Dims the JS encoder/forward need. presentCol mirrors EdgePolicyNet.PRESENT_COL.
        "config": {
            "maxAreas": config.max_areas,
            "nodeFeatures": config.node_features,
            "playerFeatures": config.player_features,
            "boardFeatures": config.board_features,
            "edgeFeatures": config.edge_features,
            "nodeHidden": config.node_hidden,
            "playerHidden": config.player_hidden,
            "contextHidden": config.context_hidden,
            "edgeHidden": config.edge_hidden,
            "presentCol": EdgePolicyNet.PRESENT_COL,
        },
        "layers": {js_key: _dump_mlp(getattr(model, attr)) for js_key, attr in _HEADS.items()},
    }

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    n_params = sum(p.numel() for p in model.parameters())
    body = json.dumps(payload, separators=(",", ":"))
    out_path.write_text(
        "// AUTO-GENERATED by ml/dicewars_bc/export_weights.py — do not edit by hand.\n"
        "// Weights for the in-browser behavioral-cloning bot (src/ai/ai_bc.js), run via\n"
        "// the synchronous pure-JS forward pass in src/ai/bcForward.js.\n"
        f"// teacher={payload['teacher']} · {n_params} params · "
        f"selection={payload['selectionMetric']}={payload['selectionAccuracy']}\n"
        "/* eslint-disable */\n"
        f"export const BC_POLICY = {body};\n"
    )
    print(
        f"Wrote JS weights → {out_path}  ({n_params:,} params, {out_path.stat().st_size:,} bytes)"
    )

    if fixture_path is not None:
        fixture = {"config": payload["config"], **_make_fixture(model, config)}
        fixture_path = Path(fixture_path)
        fixture_path.parent.mkdir(parents=True, exist_ok=True)
        fixture_path.write_text(json.dumps(fixture, indent=2) + "\n")
        print(f"Wrote JS↔Python parity fixture → {fixture_path}  ({len(fixture['cases'])} cases)")

    return out_path


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Export a BC checkpoint to a JS weights module")
    p.add_argument("--ckpt", required=True, help="Trained checkpoint (.pt from train.py)")
    p.add_argument("--out", default="../src/ai/bcPolicyWeights.js", help="Output .js path")
    p.add_argument(
        "--fixture",
        default=None,
        help="Also write a JS↔Python parity fixture (reference logits) to this JSON path",
    )
    return p


def main() -> None:
    args = build_parser().parse_args()
    export(args.ckpt, args.out, fixture_path=args.fixture)


if __name__ == "__main__":
    main()
