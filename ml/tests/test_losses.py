"""Segmented (per-step) loss + metric math, hand-verified on tiny cases."""

import math

import pytest

torch = pytest.importorskip("torch")

from dicewars_bc.losses import (  # noqa: E402
    policy_accuracy,
    predicted_stop_rate,
    segmented_argmax_local,
    segmented_cross_entropy,
    teacher_stop_rate,
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


def test_stop_weight_is_weight_normalized_mean():
    # Step 0: logits [1,0], label 0 → attack (label != count-1).  Step 1: logits
    # [0,0,5], label 2 → STOP (label == count-1=2).  stop_weight halves the STOP step.
    edge_logits = torch.tensor([1.0, 0.0, 0.0, 0.0, 5.0])
    edge_offsets = torch.tensor([0, 2, 5], dtype=torch.int64)
    labels = torch.tensor([0, 2], dtype=torch.int64)

    nll0 = math.log(1 + math.exp(-1))
    nll1 = math.log(2 + math.exp(5)) - 5.0
    expected = (1.0 * nll0 + 0.5 * nll1) / (1.0 + 0.5)  # weight-normalized mean

    got = segmented_cross_entropy(edge_logits, edge_offsets, labels, stop_weight=0.5)
    assert got.item() == pytest.approx(expected, abs=1e-6)


def test_stop_weight_one_is_plain_ce():
    # stop_weight=1.0 must be byte-equivalent to the default plain CE path.
    edge_logits = torch.tensor([0.5, -1.0, 2.0, 0.1, 0.2, 0.3, 1.5])
    edge_offsets = torch.tensor([0, 3, 7], dtype=torch.int64)
    labels = torch.tensor([2, 1], dtype=torch.int64)
    plain = segmented_cross_entropy(edge_logits, edge_offsets, labels)
    weighted = segmented_cross_entropy(edge_logits, edge_offsets, labels, stop_weight=1.0)
    assert weighted.item() == pytest.approx(plain.item(), abs=1e-7)


def test_stop_weight_reduces_stop_gradient_pull():
    """Down-weighting STOP must shrink the gradient that pulls the STOP logit up."""
    offsets = torch.tensor([0, 2, 5], dtype=torch.int64)
    labels = torch.tensor([0, 2], dtype=torch.int64)  # step 1 is a STOP step

    def stop_grad(stop_weight):
        logits = torch.tensor([1.0, 0.0, 0.0, 0.0, 5.0], requires_grad=True)
        segmented_cross_entropy(logits, offsets, labels, stop_weight=stop_weight).backward()
        return logits.grad[4].item()  # gradient on the chosen STOP logit (step 1)

    # NLL gradient on the chosen logit is negative (loss wants it higher); a smaller
    # weight makes it less negative → weaker pull toward STOP.
    assert abs(stop_grad(0.25)) < abs(stop_grad(1.0))


def test_focal_gamma_downweights_confident_steps():
    # A near-perfectly-classified step (logit 10 vs 0) is "easy": focal should shrink
    # its loss well below the plain CE; both stay finite and differentiable.
    edge_logits = torch.tensor([10.0, 0.0, 0.0, 0.5], requires_grad=True)
    edge_offsets = torch.tensor([0, 2, 4], dtype=torch.int64)
    labels = torch.tensor([0, 0], dtype=torch.int64)
    plain = segmented_cross_entropy(edge_logits, edge_offsets, labels)
    focal = segmented_cross_entropy(edge_logits, edge_offsets, labels, focal_gamma=2.0)
    assert focal.item() < plain.item()

    # Pin the exact (1 - p)^gamma * nll modulation, not just the inequality.
    nll0 = math.log(1 + math.exp(-10))  # chosen logit 10 vs 0
    nll1 = math.log(1 + math.exp(0.5))  # chosen logit 0 vs 0.5

    def focal_step(nll, gamma=2.0):
        # Mirror the code's clamp(1e-6, 1.0) on (1-p) so the pin stays exact even if the
        # logits above are later changed to where (1-p) would dip past the clamp floor.
        one_minus_p = min(max(1 - math.exp(-nll), 1e-6), 1.0)
        return one_minus_p**gamma * nll

    expected = (focal_step(nll0) + focal_step(nll1)) / 2
    assert focal.item() == pytest.approx(expected, abs=1e-6)

    focal.backward()
    assert torch.isfinite(edge_logits.grad).all()


def test_focal_clamp_keeps_gradient_finite_at_the_boundary():
    # A near-certain step (p→1) with a FRACTIONAL gamma would drive pow()'s gradient to
    # infinity at the (1-p)=0 boundary; the clamp(1e-6, 1.0) is exactly what bounds it.
    # Guard that intentional clamp: loss and gradient must stay finite.
    edge_logits = torch.tensor([50.0, 0.0, 0.0, 0.0], requires_grad=True)
    edge_offsets = torch.tensor([0, 2, 4], dtype=torch.int64)
    labels = torch.tensor([0, 0], dtype=torch.int64)
    loss = segmented_cross_entropy(edge_logits, edge_offsets, labels, focal_gamma=0.5)
    assert torch.isfinite(loss).all()
    loss.backward()
    assert torch.isfinite(edge_logits.grad).all()


def test_predicted_and_teacher_stop_rates():
    # Step 0 argmax → idx0 (attack); step 1 argmax → idx2 (STOP). So model STOP = 0.5.
    edge_logits = torch.tensor([1.0, 0.0, 0.0, 0.0, 5.0])
    edge_offsets = torch.tensor([0, 2, 5], dtype=torch.int64)
    assert predicted_stop_rate(edge_logits, edge_offsets).item() == pytest.approx(0.5)

    # Teacher STOP rate depends only on labels vs each segment's last index.
    assert teacher_stop_rate(edge_offsets, torch.tensor([0, 2])).item() == pytest.approx(0.5)
    assert teacher_stop_rate(edge_offsets, torch.tensor([1, 2])).item() == pytest.approx(1.0)
    assert teacher_stop_rate(edge_offsets, torch.tensor([0, 0])).item() == pytest.approx(0.0)
