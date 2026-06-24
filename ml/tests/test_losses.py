"""Segmented (per-step) loss + metric math, hand-verified on tiny cases."""

import math

import pytest

torch = pytest.importorskip("torch")

from dicewars_bc.losses import (  # noqa: E402
    policy_accuracy,
    segmented_argmax_local,
    segmented_cross_entropy,
    value_loss,
)


def test_segmented_cross_entropy_hand_computed():
    # Step 0: logits [1, 0], label 0.  Step 1: logits [0, 0, 5], label 2.
    edge_logits = torch.tensor([1.0, 0.0, 0.0, 0.0, 5.0])
    edge_offsets = torch.tensor([0, 2, 5], dtype=torch.int64)
    labels = torch.tensor([0, 2], dtype=torch.int64)

    nll0 = math.log(1 + math.exp(-1))  # -log softmax([1,0])[0]
    nll1 = math.log(math.exp(0) + math.exp(0) + math.exp(5)) - 5.0  # -log softmax([0,0,5])[2]
    expected = (nll0 + nll1) / 2

    got = segmented_cross_entropy(edge_logits, edge_offsets, labels)
    assert got.item() == pytest.approx(expected, abs=1e-5)


def test_cross_entropy_matches_torch_per_segment():
    """Cross-check the segmented CE against per-slice F.cross_entropy."""
    edge_logits = torch.tensor([0.5, -1.0, 2.0, 0.1, 0.2, 0.3, 1.5])
    edge_offsets = torch.tensor([0, 3, 7], dtype=torch.int64)
    labels = torch.tensor([2, 1], dtype=torch.int64)

    ref0 = torch.nn.functional.cross_entropy(edge_logits[0:3].unsqueeze(0), labels[0:1])
    ref1 = torch.nn.functional.cross_entropy(edge_logits[3:7].unsqueeze(0), labels[1:2])
    expected = (ref0 + ref1) / 2

    got = segmented_cross_entropy(edge_logits, edge_offsets, labels)
    assert got.item() == pytest.approx(expected.item(), abs=1e-5)


def test_segmented_argmax_and_accuracy():
    edge_logits = torch.tensor([1.0, 0.0, 0.0, 0.0, 5.0])
    edge_offsets = torch.tensor([0, 2, 5], dtype=torch.int64)

    pred = segmented_argmax_local(edge_logits, edge_offsets)
    assert pred.tolist() == [0, 2]

    assert policy_accuracy(edge_logits, edge_offsets, torch.tensor([0, 2])).item() == 1.0
    assert policy_accuracy(edge_logits, edge_offsets, torch.tensor([1, 2])).item() == 0.5
    assert policy_accuracy(edge_logits, edge_offsets, torch.tensor([1, 0])).item() == 0.0


def test_argmax_first_occurrence_tiebreak():
    # Two edges tie for max in segment 0 → first occurrence (local idx 0).
    edge_logits = torch.tensor([2.0, 2.0, 0.0])
    edge_offsets = torch.tensor([0, 3], dtype=torch.int64)
    assert segmented_argmax_local(edge_logits, edge_offsets).tolist() == [0]


def test_value_loss():
    # won well-classified (BCE≈0); placement at sigmoid(0)=0.5 vs {1,0} → MSE=0.25.
    value_pred = torch.tensor([[10.0, 0.0], [-10.0, 0.0]])
    value_target = torch.tensor([[1.0, 1.0], [0.0, 0.0]])
    assert value_loss(value_pred, value_target).item() == pytest.approx(0.25, abs=1e-3)


def test_cross_entropy_is_differentiable():
    edge_logits = torch.tensor([0.2, 0.4, 0.1, 0.9], requires_grad=True)
    edge_offsets = torch.tensor([0, 2, 4], dtype=torch.int64)
    labels = torch.tensor([1, 0], dtype=torch.int64)
    loss = segmented_cross_entropy(edge_logits, edge_offsets, labels)
    loss.backward()
    assert edge_logits.grad is not None
    assert torch.isfinite(edge_logits.grad).all()
