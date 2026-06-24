"""Segmented (per-step) policy losses over the flat CSR edge layout.

The model emits one logit per edge across the whole batch, flat: ``edge_logits``
shape ``[E]``. Each *step* owns a contiguous slice (its legal moves + STOP), and
the policy is a softmax **within that step's slice only** — never across steps.
So the BC cross-entropy is a *segmented* softmax keyed by the per-batch CSR
offsets, with the teacher's LOCAL chosen-edge index as the target.

These ops live here (not in the model) on purpose: the exported ONNX graph is
**logits-only** (the JS bot argmaxes the legal edges itself), so keeping the
segment/softmax math out of ``forward`` keeps the export portable and avoids any
``scatter_reduce``-in-ONNX-opset concerns.
"""

from __future__ import annotations

import torch
import torch.nn.functional as F


def _segment_ids(edge_offsets: torch.Tensor) -> torch.Tensor:
    """Per-edge step id (0..B-1) from per-batch CSR offsets [B+1]. The result has
    length ``edge_offsets[-1]`` (= total edges) by construction."""
    counts = edge_offsets[1:] - edge_offsets[:-1]
    return torch.repeat_interleave(
        torch.arange(counts.shape[0], device=edge_offsets.device), counts
    )


def segmented_cross_entropy(
    edge_logits: torch.Tensor,
    edge_offsets: torch.Tensor,
    labels: torch.Tensor,
    *,
    stop_weight: float = 1.0,
    focal_gamma: float = 0.0,
) -> torch.Tensor:
    """(Optionally STOP-reweighted / focal) mean NLL of the teacher's chosen edge.

    Args:
        edge_logits: [E] flat per-edge logits (steps concatenated in CSR order).
        edge_offsets: [B+1] per-batch CSR row pointers (offsets[0]=0, offsets[B]=E).
        labels: [B] LOCAL chosen-edge index within each step's slice.
        stop_weight: per-step weight applied to steps whose teacher label is STOP
            (the trailing edge of the segment, ``label == count-1``). ``<1`` down-
            weights STOP to counter the clone's STOP over-prediction (the Phase-2
            de-bias lever — the training analog of the inference-time ``stopBias``
            knob in ``ai_bc.js``). ``1.0`` (default) is plain CE. When ``!= 1.0`` the
            reduction is a weight-normalized mean (matches ``F.cross_entropy(weight=)``
            semantics, so the loss scale stays comparable across weights).
        focal_gamma: focal-loss exponent. ``>0`` multiplies each step's NLL by
            ``(1 - p_chosen) ** gamma``, down-weighting easy/confident steps (STOP is
            the dominant easy class, so this also damps STOP). ``0.0`` (default) off.

    Returns:
        Scalar mean cross-entropy over the B steps. With both knobs at their
        defaults this is exactly ``segmented_nll_per_step(...).mean()``.
    """
    nll = segmented_nll_per_step(edge_logits, edge_offsets, labels)

    if focal_gamma > 0.0:
        # p(chosen) = exp(-nll); (1-p)^gamma is the standard focal modulation.
        # Clamp keeps (1-p) off the 0/1 edges so a fractional gamma can't blow up
        # the gradient of pow() at the boundary.
        p = torch.exp(-nll)
        nll = (1.0 - p).clamp(1e-6, 1.0).pow(focal_gamma) * nll

    if stop_weight != 1.0:
        counts = edge_offsets[1:] - edge_offsets[:-1]
        is_stop = labels == (counts - 1)
        weights = torch.where(
            is_stop,
            edge_logits.new_tensor(float(stop_weight)),
            edge_logits.new_tensor(1.0),
        )
        return (weights * nll).sum() / weights.sum().clamp_min(1e-8)

    return nll.mean()


def segmented_nll_per_step(
    edge_logits: torch.Tensor, edge_offsets: torch.Tensor, labels: torch.Tensor
) -> torch.Tensor:
    """Per-step NLL ``-log p(chosen)`` under the segmented softmax. Shape [B].

    Uses the max-shift trick per segment for numerical stability. Every step has
    at least the STOP edge, so no segment is empty.
    """
    num_steps = labels.shape[0]
    seg = _segment_ids(edge_offsets)

    # Per-segment max (stability), then logsumexp within each segment.
    seg_max = torch.full((num_steps,), float("-inf"), device=edge_logits.device)
    seg_max = seg_max.scatter_reduce(0, seg, edge_logits, reduce="amax", include_self=True)
    shifted_exp = (edge_logits - seg_max[seg]).exp()
    seg_sum = torch.zeros(num_steps, device=edge_logits.device).scatter_add(0, seg, shifted_exp)
    log_z = seg_max + seg_sum.log()  # [B] logsumexp per step

    chosen_global = edge_offsets[:-1] + labels  # [B] global row of the chosen edge
    chosen_logit = edge_logits[chosen_global]
    return -(chosen_logit - log_z)


def segmented_argmax_local(
    edge_logits: torch.Tensor, edge_offsets: torch.Tensor
) -> torch.Tensor:
    """LOCAL index of the highest-logit edge within each step's slice. Shape [B].

    First-occurrence tie-break (matches ``torch.argmax``). Vectorized so it is
    usable on full eval batches.
    """
    num_steps = edge_offsets.shape[0] - 1
    seg = _segment_ids(edge_offsets)

    seg_max = torch.full((num_steps,), float("-inf"), device=edge_logits.device)
    seg_max = seg_max.scatter_reduce(0, seg, edge_logits, reduce="amax", include_self=True)

    # Among the edges equal to their segment max, take the lowest global index
    # (first occurrence). seg_max came from amax of these exact values, so the
    # equality test is exact for the winning element.
    is_max = edge_logits == seg_max[seg]
    big = edge_logits.shape[0]
    global_idx = torch.arange(edge_logits.shape[0], device=edge_logits.device)
    masked_idx = torch.where(is_max, global_idx, torch.full_like(global_idx, big))
    seg_min = torch.full((num_steps,), big, dtype=torch.int64, device=edge_logits.device)
    seg_min = seg_min.scatter_reduce(0, seg, masked_idx, reduce="amin", include_self=True)
    return seg_min - edge_offsets[:-1]


def policy_accuracy(
    edge_logits: torch.Tensor, edge_offsets: torch.Tensor, labels: torch.Tensor
) -> torch.Tensor:
    """Fraction of steps where the argmax edge matches the teacher (top-1)."""
    pred = segmented_argmax_local(edge_logits, edge_offsets)
    return (pred == labels).float().mean()


def _is_stop_segment(edge_offsets: torch.Tensor, local_idx: torch.Tensor) -> torch.Tensor:
    """Per-step bool: is ``local_idx`` the STOP edge (the last edge of its segment)?

    STOP is provably the trailing edge of every step's slice (the encoder always
    appends it; the corpus integrity check enforces ``count >= 1``), so STOP's local
    index is ``count - 1``.
    """
    counts = edge_offsets[1:] - edge_offsets[:-1]
    return local_idx == (counts - 1)


def predicted_stop_rate(
    edge_logits: torch.Tensor, edge_offsets: torch.Tensor
) -> torch.Tensor:
    """Fraction of steps whose ARGMAX edge is STOP.

    This is the realized STOP rate of the deployed bot (which argmaxes the legal
    edges with ``stopBias=0`` once the de-bias is baked into the weights), so it is
    the calibration target for checkpoint selection in the STOP-de-bias retrain —
    NOT val move-match, which the broken Phase-2 run showed is a STOP-biased proxy.
    """
    pred = segmented_argmax_local(edge_logits, edge_offsets)
    return _is_stop_segment(edge_offsets, pred).float().mean()


def teacher_stop_rate(edge_offsets: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
    """Fraction of steps where the TEACHER chose STOP (``label == count-1``). The
    ground-truth STOP rate the de-biased clone should reproduce (~45% for Lookahead)."""
    return _is_stop_segment(edge_offsets, labels).float().mean()


def value_loss(value_pred: torch.Tensor, value_target: torch.Tensor) -> torch.Tensor:
    """Aux value-head loss: BCE on ``won`` + MSE on ``placement`` (both in [0,1]).

    ``value_pred`` is [B, 2] raw outputs: column 0 a ``won`` logit, column 1 a
    ``placement`` logit (sigmoid → [0,1] regression target). Recommended,
    multi-task, warm-starts Phase-3 PPO (D-Encoding).
    """
    won_loss = F.binary_cross_entropy_with_logits(value_pred[:, 0], value_target[:, 0])
    placement_loss = F.mse_loss(torch.sigmoid(value_pred[:, 1]), value_target[:, 1])
    return won_loss + placement_loss
