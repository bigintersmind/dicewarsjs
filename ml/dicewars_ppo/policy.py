"""The Phase-3 PPO policy — an ``EdgePolicyNet``-trunk actor + a fresh scalar critic.

This is the custom sb3-contrib ``MaskableActorCriticPolicy`` from PLAN step 5 /
[D-19]. It reuses the behavioral-cloning net's trunk and per-edge head
(``dicewars_bc.EdgePolicyNet``) as the PPO actor, with a **fresh scalar critic**
off the same context vector — PPO needs a bootstrappable ``V(s)``, and BC's
2-output ``(won, placement)`` value head is not one.

**Why override the four call-sites instead of the features-extractor mold.** SB3's
``features_extractor → mlp_extractor → action_net`` pipeline assumes a fixed-width
latent feeding a flat action head. Our action head is *per-edge* — a ragged set of
``(from, to)`` logits gathered out of node embeddings — so we bypass that pipeline
and override the four methods MaskablePPO actually calls (``forward`` /
``evaluate_actions`` / ``predict_values`` / ``get_distribution``), computing the
padded-``MAX_EDGES`` edge logits and the scalar value directly from the obs Dict.
``self.action_dist`` is already a ``MaskableCategoricalDistribution`` (set by the
base ``__init__``); we feed it the padded logits and let MaskablePPO's collected
``action_masks`` zero the pad tail.

**Repackability (the [D-19] gate constraint).** The actor IS a real
``EdgePolicyNet`` instance held at ``self.bc_net`` — same submodule names as a bare
BC net — so :func:`repack_to_bc_checkpoint` can pull its ``state_dict`` straight
back into the BC checkpoint format that ``dicewars_bc.export_weights`` /
``export_onnx`` consume. Without that, the graded bot would not be the trained
policy (the gate-breaking gap [D-19] flagged). The fresh critic is PPO-only and is
dropped on repack; the BC ``value_head`` rides along untouched (PPO never puts it in
a loss, so its grad stays ``None`` and the warm-started weights survive) so the
JS↔Py parity fixture still runs.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import torch
from sb3_contrib.common.maskable.distributions import MaskableCategoricalDistribution
from sb3_contrib.common.maskable.policies import MaskableActorCriticPolicy
from torch import nn

from dicewars_bc.model import EdgePolicyNet, ModelConfig

from .constants import BOARD_W, EDGE_W, ENCODING_VERSION, NODE_W, PLAYER_W


def _assert_v2_config(cfg: ModelConfig) -> None:
    """Fail loud if a checkpoint's feature widths don't match the v2 wire contract.

    The env emits the v2 encoding (``constants.{NODE,PLAYER,BOARD,EDGE}_W``); a
    policy built around a stale-version ``ModelConfig`` (e.g. encoding-v1's node5/
    edge4) would silently shape-mismatch the live observation. Check up front.
    """
    mismatches = [
        f"{name}: config={got} != wire={want}"
        for name, got, want in (
            ("node_features", cfg.node_features, NODE_W),
            ("player_features", cfg.player_features, PLAYER_W),
            ("board_features", cfg.board_features, BOARD_W),
            ("edge_features", cfg.edge_features, EDGE_W),
        )
        if got != want
    ]
    if mismatches:
        raise ValueError(
            "ModelConfig feature widths are not the v2 wire contract "
            f"(dicewars_ppo.constants): {'; '.join(mismatches)}. Warm-start from a "
            "v2 BC checkpoint (encoding_version == 2)."
        )


class MaskableEdgePolicy(MaskableActorCriticPolicy):
    """``EdgePolicyNet``-trunk actor + fresh scalar critic for MaskablePPO.

    Pass the BC ``ModelConfig`` via ``policy_kwargs={"bc_config": cfg}`` when
    constructing ``MaskablePPO`` (or use :func:`build_policy` standalone). The obs
    is the v2 ``Dict`` from :class:`dicewars_ppo.env.DiceWarsEnv`; the action space
    is ``Discrete(MAX_EDGES)``.
    """

    def __init__(self, *args: Any, bc_config: ModelConfig, **kwargs: Any) -> None:
        _assert_v2_config(bc_config)
        # Stash before super().__init__ — the base calls self._build() at the end,
        # and our override reads self._bc_config. (nn.Module.__setattr__ tolerates a
        # plain-object attribute set before Module.__init__.)
        self._bc_config = bc_config
        super().__init__(*args, **kwargs)

    def _build(self, lr_schedule: Any) -> None:
        """Build the actor (BC net) + a fresh scalar critic + the optimizer.

        Overrides the base ``_build`` wholesale: we do NOT build the base's
        ``mlp_extractor`` / ``action_net`` (the per-edge head replaces them).
        ``self.action_dist`` is already a ``MaskableCategoricalDistribution`` from
        the base ``__init__``. Any default features extractor SB3 builds (a
        param-less ``FlattenExtractor`` over our Dict obs) is left unused — every
        overridden method reads the obs Dict directly, so we don't depend on its
        class or on exactly when the base instantiates it.
        """
        self.bc_net = EdgePolicyNet(self._bc_config)
        # Fresh scalar critic off ctx (PPO V(s)); separate from BC's value_head.
        self.value_net = nn.Linear(self._bc_config.context_hidden, 1)
        self.optimizer = self.optimizer_class(
            self.parameters(), lr=lr_schedule(1), **self.optimizer_kwargs
        )

    # --- core: obs Dict → (padded edge logits [N, MAX_EDGES], values [N, 1]) ------

    def _edge_logits_and_values(
        self, obs: dict[str, torch.Tensor]
    ) -> tuple[torch.Tensor, torch.Tensor]:
        nodes = obs["nodes"]  # [N, A, NODE_W] f32
        players = obs["players"]  # [N, P, PLAYER_W] f32
        board = obs["board"]  # [N, BOARD_W] f32
        edge_feat = obs["edge_feat"]  # [N, ME, EDGE_W] f32
        edge_from = obs["edge_from"].long()  # [N, ME]  (int32 on the wire → index needs int64)
        edge_to = obs["edge_to"].long()  # [N, ME]
        n, me = edge_from.shape

        node_emb, ctx = self.bc_net.encode_context(nodes, players, board)  # [N,A,H], [N,C]

        # Flatten the padded [N, ME] edges into the ragged [E]-form the edge head
        # expects, tagging every edge with its batch row. Pad slots (from=to=0, the
        # absent-node sentinel) index row b's node 0 — in-bounds garbage that the
        # action mask discards, so no OOB and no special-casing.
        edge_batch = torch.arange(n, device=edge_from.device).repeat_interleave(me)  # [N*ME]
        edge_logits_flat = self.bc_net.edge_logits_from_context(
            node_emb,
            ctx,
            edge_feat.reshape(n * me, EDGE_W),
            edge_from.reshape(n * me),
            edge_to.reshape(n * me),
            edge_batch,
        )  # [N*ME]
        edge_logits = edge_logits_flat.view(n, me)  # [N, ME]
        values = self.value_net(ctx)  # [N, 1]
        return edge_logits, values

    def _distribution(
        self, edge_logits: torch.Tensor, action_masks: torch.Tensor | None
    ) -> MaskableCategoricalDistribution:
        distribution = self.action_dist.proba_distribution(action_logits=edge_logits)
        if action_masks is not None:
            distribution.apply_masking(action_masks)
        return distribution

    # --- the four sb3-contrib call-sites -----------------------------------------

    def forward(
        self,
        obs: dict[str, torch.Tensor],
        deterministic: bool = False,
        action_masks: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        edge_logits, values = self._edge_logits_and_values(obs)
        distribution = self._distribution(edge_logits, action_masks)
        actions = distribution.get_actions(deterministic=deterministic)
        log_prob = distribution.log_prob(actions)
        return actions, values, log_prob

    def evaluate_actions(
        self,
        obs: dict[str, torch.Tensor],
        actions: torch.Tensor,
        action_masks: torch.Tensor | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        edge_logits, values = self._edge_logits_and_values(obs)
        distribution = self._distribution(edge_logits, action_masks)
        log_prob = distribution.log_prob(actions)
        return values, log_prob, distribution.entropy()

    def get_distribution(
        self, obs: dict[str, torch.Tensor], action_masks: torch.Tensor | None = None
    ) -> MaskableCategoricalDistribution:
        edge_logits, _ = self._edge_logits_and_values(obs)
        return self._distribution(edge_logits, action_masks)

    def predict_values(self, obs: dict[str, torch.Tensor]) -> torch.Tensor:
        _, values = self._edge_logits_and_values(obs)
        return values


def build_policy(
    observation_space: Any,
    action_space: Any,
    bc_config: ModelConfig,
    *,
    lr: float = 3e-4,
    **kwargs: Any,
) -> MaskableEdgePolicy:
    """Construct a :class:`MaskableEdgePolicy` standalone (outside ``MaskablePPO``).

    MaskablePPO builds the policy itself from ``policy_kwargs``; this helper is for
    tests / warm-start-then-repack scripts that need a policy without a full learner.
    """
    return MaskableEdgePolicy(
        observation_space,
        action_space,
        lr_schedule=lambda _progress: lr,
        bc_config=bc_config,
        **kwargs,
    )


# --- warm-start / repack: the BC <-> PPO checkpoint bridge ------------------------


def load_bc_checkpoint(ckpt_path: str | Path) -> tuple[ModelConfig, dict]:
    """Load a v2 BC checkpoint, asserting ``encoding_version == 2``.

    Returns ``(config, checkpoint_dict)``. Raises if the checkpoint is a stale
    encoding version (a v1 net would shape-mismatch the live v2 observation).
    """
    # weights_only=True: our BC checkpoints are tensors + a plain dict/str/num config
    # (same as dicewars_bc.export_onnx), so this avoids the arbitrary-code-execution
    # unpickler path that weights_only=False enables.
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=True)
    ev = ckpt.get("encoding_version")
    if ev != ENCODING_VERSION:
        raise ValueError(
            f"checkpoint encoding_version={ev!r} != {ENCODING_VERSION} ({ckpt_path}); "
            "PPO warm-start must use the v2 BC checkpoint (the deployed ai_bc)."
        )
    cfg = ModelConfig(**ckpt["config"])
    _assert_v2_config(cfg)
    return cfg, ckpt


def warm_start_from_bc(policy: MaskableEdgePolicy, ckpt: dict) -> None:
    """Load BC trunk + ``edge_head`` (+ ``value_head``) into the policy's actor.

    Validates the checkpoint up front — ``encoding_version == 2``, v2 feature widths,
    and that its ``ModelConfig`` matches the one the policy was built from — so a
    stale/mismatched checkpoint fails with an actionable message rather than a raw
    ``load_state_dict`` size-mismatch dump, and a same-shape/different-encoding
    checkpoint can't warm-start silently. This is a separate public entry point from
    :func:`load_bc_checkpoint`, so it re-checks rather than trusting the caller.

    The actor (``policy.bc_net``) is a bare ``EdgePolicyNet`` with the checkpoint's
    ``ModelConfig``, so ``state_dict`` keys line up exactly (``strict=True``). The
    fresh scalar critic (``policy.value_net``) is intentionally left at its init —
    PPO learns it. The BC ``value_head`` loads too but PPO never trains it (no loss
    references it), so it survives for the repack parity fixture.
    """
    ev = ckpt.get("encoding_version")
    if ev != ENCODING_VERSION:
        raise ValueError(
            f"warm-start checkpoint encoding_version={ev!r} != {ENCODING_VERSION}; "
            "must be the v2 BC checkpoint (the deployed ai_bc)."
        )
    ckpt_cfg = ModelConfig(**ckpt["config"])
    _assert_v2_config(ckpt_cfg)
    if ckpt_cfg != policy.bc_net.config:
        raise ValueError(
            f"warm-start checkpoint config {ckpt_cfg} != policy config "
            f"{policy.bc_net.config}; the policy was built from a different "
            "ModelConfig than the checkpoint."
        )
    policy.bc_net.load_state_dict(ckpt["state_dict"], strict=True)


def repack_to_bc_checkpoint(
    policy: MaskableEdgePolicy, *, extra: dict | None = None
) -> dict:
    """Repack the trained actor back into BC checkpoint format (the step-7 gate).

    Produces exactly what ``dicewars_bc.export_weights`` / ``export_onnx`` consume:
    a bare-``EdgePolicyNet`` ``state_dict`` + its ``config`` + ``encoding_version``.
    The PPO scalar critic is dropped (it's training-only). Pass ``extra`` to stamp
    provenance (e.g. ``teacher``, training step). The inverse of
    :func:`warm_start_from_bc` — round-trips to a byte-identical ``EdgePolicyNet``.
    """
    ckpt = {
        "state_dict": policy.bc_net.state_dict(),
        "config": policy.bc_net.config.to_dict(),
        "encoding_version": ENCODING_VERSION,
    }
    if extra:
        clobbered = ckpt.keys() & extra.keys()
        if clobbered:
            raise ValueError(
                f"repack `extra` may not override canonical checkpoint keys: "
                f"{sorted(clobbered)} (use it only for provenance like `teacher`/step)."
            )
        ckpt.update(extra)
    return ckpt
