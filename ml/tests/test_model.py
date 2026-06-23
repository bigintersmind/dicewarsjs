"""EdgePolicyNet forward: shapes, determinism, seat-symmetry, edge routing."""

import pytest

torch = pytest.importorskip("torch")

from dicewars_bc.model import EdgePolicyNet, ModelConfig  # noqa: E402


def _config(max_areas=6):
    return ModelConfig(
        max_areas=max_areas, node_features=5, player_features=6, board_features=5, edge_features=4
    )


def _rand_inputs(b, max_areas, p, n_edges_per_step, seed=0):
    g = torch.Generator().manual_seed(seed)
    nodes = torch.rand(b, max_areas, 5, generator=g)
    nodes[..., 0] = (torch.rand(b, max_areas, generator=g) > 0.3).float()
    players = torch.rand(b, p, 6, generator=g)
    board = torch.rand(b, 5, generator=g)

    total = b * n_edges_per_step
    edge_feat = torch.rand(total, 4, generator=g)
    edge_from = torch.randint(1, max_areas, (total,), generator=g)
    edge_to = torch.randint(1, max_areas, (total,), generator=g)
    edge_batch = torch.repeat_interleave(torch.arange(b), n_edges_per_step)
    return nodes, players, board, edge_feat, edge_from, edge_to, edge_batch


def test_forward_shapes():
    model = EdgePolicyNet(_config()).eval()
    inputs = _rand_inputs(b=3, max_areas=6, p=2, n_edges_per_step=4)
    logits, value = model(*inputs)
    assert logits.shape == (3 * 4,)
    assert value.shape == (3, 2)


def test_deterministic():
    model = EdgePolicyNet(_config()).eval()
    inputs = _rand_inputs(b=2, max_areas=6, p=2, n_edges_per_step=3)
    a_logits, a_value = model(*inputs)
    b_logits, b_value = model(*inputs)
    assert torch.equal(a_logits, b_logits)
    assert torch.equal(a_value, b_value)


def test_seat_permutation_invariance():
    """Permuting player rows must not change outputs (seat-symmetric policy)."""
    model = EdgePolicyNet(_config()).eval()
    nodes, players, board, ef, efrom, eto, eb = _rand_inputs(
        b=1, max_areas=6, p=4, n_edges_per_step=5
    )
    base_logits, base_value = model(nodes, players, board, ef, efrom, eto, eb)

    perm = torch.tensor([2, 0, 3, 1])
    players_perm = players[:, perm, :]
    perm_logits, perm_value = model(nodes, players_perm, board, ef, efrom, eto, eb)

    assert torch.allclose(base_logits, perm_logits, atol=1e-5)
    assert torch.allclose(base_value, perm_value, atol=1e-5)


def test_edges_gather_from_their_own_step():
    """An edge gathers node features from the step `edge_batch` assigns it to.

    Two identical edges in two node-worlds (step 0 all-0.1, step 1 all-0.9):
    rerouting the step-1 edge to step 0 makes its logit equal step 0's edge.
    """
    model = EdgePolicyNet(_config(max_areas=6)).eval()

    nodes = torch.empty(2, 6, 5)
    nodes[0] = 0.1
    nodes[1] = 0.9
    nodes[..., 0] = 1.0  # all present
    players = torch.full((2, 2, 6), 0.5)
    board = torch.full((2, 5), 0.5)

    edge_feat = torch.tensor([[0.3, 0.4, 0.5, 0.0], [0.3, 0.4, 0.5, 0.0]])  # identical edges
    edge_from = torch.tensor([1, 1])
    edge_to = torch.tensor([2, 2])

    # Case A: edges routed to steps 0 and 1 respectively.
    logits_a, _ = model(nodes, players, board, edge_feat, edge_from, edge_to,
                         torch.tensor([0, 1]))
    # Case B: both edges routed to step 0.
    logits_b, _ = model(nodes, players, board, edge_feat, edge_from, edge_to,
                         torch.tensor([0, 0]))

    # Different node-worlds → the two A-edges differ.
    assert not torch.allclose(logits_a[0], logits_a[1])
    # Rerouting edge 1 to step 0 makes it match step 0's edge exactly.
    assert torch.allclose(logits_b[1], logits_a[0], atol=1e-6)
    # ...and changed it from its step-1 value.
    assert not torch.allclose(logits_b[1], logits_a[1])


def test_present_mask_pooling_ignores_absent_nodes():
    """Changing an ABSENT node's (present=0) features must not change context."""
    model = EdgePolicyNet(_config(max_areas=6)).eval()
    nodes, players, board, ef, efrom, eto, eb = _rand_inputs(
        b=1, max_areas=6, p=2, n_edges_per_step=3, seed=3
    )
    # Force node id 5 absent, then perturb its (ignored) features.
    nodes[0, 5, 0] = 0.0
    _, base_emb = model.encode_context(nodes, players, board)

    nodes2 = nodes.clone()
    nodes2[0, 5, 1:] = 1234.0  # garbage in an absent node's non-present columns
    _, emb2 = model.encode_context(nodes2, players, board)

    assert torch.allclose(base_emb, emb2, atol=1e-5)
