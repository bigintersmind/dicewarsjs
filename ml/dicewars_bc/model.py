"""The behavioral-cloning net — a masked per-edge MLP (+ aux value head).

Per D-Encoding's net-architecture guidance: *start with the simplest learner
that can clone — a masked per-edge MLP over node+global+edge features — and
escalate to a 1–2 layer GNN only if the MLP can't reach parity.* This is that
MLP. The clone only needs to reproduce the policy mapping (obs → move), not the
teacher's depth-2 search itself.

Shape of one decision step's forward:

    nodes      [A, Fn]   → per-node encoder → node_emb [A, H]
                           (masked pool over present nodes → board node summary)
    players    [P, Fp]   → per-player encoder → mean-pool over seats  (seat-symmetric)
    board      [Fb]      ── concat with the two pools → context MLP → ctx [C]
    each edge  [Fe] + (from,to) node embeddings + ctx → edge MLP → 1 logit
    ctx                  → value MLP → [won_logit, placement_logit]

**Seat symmetry.** Owner identity is carried *relationally* (``is_mine`` /
``is_enemy`` on nodes, ``is_me`` on players) — never as an absolute seat
one-hot. We honor that by mean-pooling the per-player embeddings (a
permutation-invariant aggregate); the acting seat stays distinguished only via
its ``is_me`` feature, not its row position. So permuting seat rows leaves the
output unchanged.

**Batching.** A whole batch of steps is processed flat/segmented (see
``dataset.collate`` / ``losses``): dense per-step tensors are ``[B, ...]`` and
edges are flat ``[E, ...]`` tagged with ``edge_batch`` (which step each edge
belongs to). The same ``forward`` runs at B=1 for the single-step ONNX export.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

import torch
from torch import nn

from .manifest import CorpusManifest


@dataclass
class ModelConfig:
    """Dims (from the corpus manifest) + hidden sizes."""

    max_areas: int
    node_features: int
    player_features: int
    board_features: int
    edge_features: int
    # Seat count of the corpus this model targets. The net is seat-count-agnostic
    # (mean-pool over seats), so this is metadata only — used to size the ONNX
    # export example and stamp the contract. Defaults to the engine default (7).
    player_count: int = 7
    node_hidden: int = 64
    player_hidden: int = 32
    context_hidden: int = 128
    edge_hidden: int = 128

    @classmethod
    def from_manifest(cls, m: CorpusManifest, **overrides) -> ModelConfig:
        return cls(
            max_areas=m.max_areas,
            node_features=m.node_features,
            player_features=m.player_features,
            board_features=m.board_features,
            edge_features=m.edge_features,
            player_count=m.player_count,
            **overrides,
        )

    def to_dict(self) -> dict:
        # asdict() is the canonical dataclass→dict (round-trips via ModelConfig(**d))
        # and, unlike __dict__, won't leak any non-field attribute set on the instance.
        return asdict(self)


def _mlp(sizes: list[int]) -> nn.Sequential:
    """A simple ReLU MLP. ``sizes`` includes input and output widths."""
    layers: list[nn.Module] = []
    for i in range(len(sizes) - 1):
        layers.append(nn.Linear(sizes[i], sizes[i + 1]))
        if i < len(sizes) - 2:
            layers.append(nn.ReLU())
    return nn.Sequential(*layers)


class EdgePolicyNet(nn.Module):
    """Masked per-edge policy + auxiliary value head."""

    # Node feature column 0 is `present` (1 for a real territory, 0 for an
    # absent/sentinel id) — the mask for node pooling. Matches NODE_FEATURES[0]
    # in src/arena/encodeObservation.js.
    PRESENT_COL = 0

    def __init__(self, config: ModelConfig):
        super().__init__()
        self.config = config
        c = config

        self.node_encoder = _mlp([c.node_features, c.node_hidden, c.node_hidden])
        self.player_encoder = _mlp([c.player_features, c.player_hidden, c.player_hidden])

        context_in = c.node_hidden + c.player_hidden + c.board_features
        self.context = _mlp([context_in, c.context_hidden, c.context_hidden])

        # Edge head input: ctx + from-node emb + to-node emb + raw edge features.
        edge_in = c.context_hidden + 2 * c.node_hidden + c.edge_features
        self.edge_head = _mlp([edge_in, c.edge_hidden, c.edge_hidden, 1])

        # Aux value head: [won_logit, placement_logit].
        self.value_head = _mlp([c.context_hidden, c.context_hidden, 2])

    def encode_context(
        self, nodes: torch.Tensor, players: torch.Tensor, board: torch.Tensor
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return ``(node_emb [B, A, H], ctx [B, C])``."""
        node_emb = self.node_encoder(nodes)  # [B, A, H]

        # Masked mean over present nodes only — absent ids would otherwise inject
        # a constant encoder(0) bias into the pool.
        present = nodes[..., self.PRESENT_COL].unsqueeze(-1)  # [B, A, 1]
        node_sum = (node_emb * present).sum(dim=1)  # [B, H]
        node_count = present.sum(dim=1).clamp(min=1.0)  # [B, 1]
        node_pool = node_sum / node_count  # [B, H]

        # Mean over seats: permutation-invariant (seat-symmetric); `is_me` keeps
        # the acting seat distinguished as a feature, not a row position.
        player_pool = self.player_encoder(players).mean(dim=1)  # [B, Hp]

        ctx = self.context(torch.cat([node_pool, player_pool, board], dim=-1))  # [B, C]
        return node_emb, ctx

    def edge_logits_from_context(
        self,
        node_emb: torch.Tensor,  # [B, A, H]
        ctx: torch.Tensor,  # [B, C]
        edge_feat: torch.Tensor,  # [E, Fe]
        edge_from: torch.Tensor,  # [E] int64
        edge_to: torch.Tensor,  # [E] int64
        edge_batch: torch.Tensor,  # [E] int64 — which step each edge belongs to
    ) -> torch.Tensor:
        """Per-edge logits ``[E]`` from a precomputed context (the edge head).

        Split out of :meth:`forward` so the Phase-3 PPO policy (``dicewars_ppo``)
        runs the *exact same* edge-head gather as the BC forward / ONNX export — one
        source of truth, no drift between the trained policy and the graded bot.
        Only gathers/Linear/ReLU, so it stays ONNX-trace-friendly with dynamic ``E``
        and ``B``.

        Each edge indexes its OWN step's node block: flatten ``[B, A, H] → [B*A, H]``
        and gather at ``edge_batch * A + id``. ``reshape(-1, H)`` keeps the batch dim
        dynamic (so the ONNX export does too).
        """
        a = node_emb.shape[1]  # max_areas — statically fixed node-tensor width
        flat_nodes = node_emb.reshape(-1, node_emb.shape[-1])  # [B*A, H]
        from_emb = flat_nodes.index_select(0, edge_batch * a + edge_from)  # [E, H]
        to_emb = flat_nodes.index_select(0, edge_batch * a + edge_to)  # [E, H]
        ctx_e = ctx.index_select(0, edge_batch)  # [E, C]

        edge_in = torch.cat([ctx_e, from_emb, to_emb, edge_feat], dim=-1)
        return self.edge_head(edge_in).squeeze(-1)  # [E]

    def forward(
        self,
        nodes: torch.Tensor,  # [B, A, Fn]
        players: torch.Tensor,  # [B, P, Fp]
        board: torch.Tensor,  # [B, Fb]
        edge_feat: torch.Tensor,  # [E, Fe]
        edge_from: torch.Tensor,  # [E] int64
        edge_to: torch.Tensor,  # [E] int64
        edge_batch: torch.Tensor,  # [E] int64 — which step each edge belongs to
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """Return ``(edge_logits [E], value [B, 2])``.

        ONNX-export-friendly: only gathers/Linear/ReLU — no data-dependent
        control flow, so it traces cleanly with dynamic ``E`` (edges) and ``B``.
        """
        node_emb, ctx = self.encode_context(nodes, players, board)
        edge_logits = self.edge_logits_from_context(
            node_emb, ctx, edge_feat, edge_from, edge_to, edge_batch
        )
        value = self.value_head(ctx)  # [B, 2]
        return edge_logits, value
