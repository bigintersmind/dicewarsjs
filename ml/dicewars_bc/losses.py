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
    edge_logits: torch.Tensor, edge_offsets: torch.Tensor, labels: torch.Tensor
) -> torch.Tensor:
    """Mean NLL of the teacher's chosen edge under a per-step softmax.

    Args:
        edge_logits: [E] flat per-edge logits (steps concatenated in CSR order).
        edge_offsets: [B+1] per-batch CSR row pointers (offsets[0]=0, offsets[B]=E).
        labels: [B] LOCAL chosen-edge index within each step's slice.

    Returns:
        Scalar mean cross-entropy over the B steps.
    """
    nll = segmented_nll_per_step(edge_logits, edge_offsets, labels)
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


def value_loss(value_pred: torch.Tensor, value_target: torch.Tensor) -> torch.Tensor:
    """Aux value-head loss: BCE on ``won`` + MSE on ``placement`` (both in [0,1]).

    ``value_pred`` is [B, 2] raw outputs: column 0 a ``won`` logit, column 1 a
    ``placement`` logit (sigmoid → [0,1] regression target). Recommended,
    multi-task, warm-starts Phase-3 PPO (D-Encoding).
    """
    won_loss = F.binary_cross_entropy_with_logits(value_pred[:, 0], value_target[:, 0])
    placement_loss = F.mse_loss(torch.sigmoid(value_pred[:, 1]), value_target[:, 1])
    return won_loss + placement_loss
