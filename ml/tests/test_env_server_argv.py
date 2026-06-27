"""EnvServerProcess argv construction — the Python→Node flag bridge (Phase 3, task B — [D-23]).

``EnvServerProcess.__init__`` builds the ``ppo-env-server.mjs`` argv eagerly (before any spawn), so
the league/PFSP flags it forwards can be asserted without a live Node process. This is the only
automated guard on that bridge: a forwarding typo (e.g. piping ``pfsp_k`` into ``--pfsp-epsilon``)
would otherwise surface only on a multi-hour shodan run. ``node_bin="node"`` skips the PATH lookup
so the test needs no Node install; the constructor still verifies ``SERVER_SCRIPT`` exists.

No torch/SB3 import here — ``env_server`` is stdlib-only, so this runs in the lean ``ml-test`` job.
"""

from __future__ import annotations

from dicewars_ppo.env_server import EnvServerProcess


def _argv(**kwargs) -> list[str]:
    return EnvServerProcess(node_bin="node", **kwargs)._argv


def test_pfsp_flags_forwarded_with_snapshot_manifest():
    argv = _argv(
        snapshot_manifest="/tmp/snap/manifest.json",
        snapshot_pool_cap=12,
        reserve_baselines=4,
        pfsp_epsilon=0.1,
        pfsp_k=3.0,
    )
    assert "--snapshot-manifest=/tmp/snap/manifest.json" in argv
    assert "--snapshot-pool-cap=12" in argv
    assert "--reserve-baselines=4" in argv
    assert "--pfsp-epsilon=0.1" in argv
    assert "--pfsp-k=3.0" in argv


def test_pfsp_flags_use_b4_defaults():
    argv = _argv(snapshot_manifest="/tmp/snap/manifest.json")
    # B4 defaults must match makeLeague's (R=3, eps=0.05, k=2); drift here silently retunes runs.
    assert "--reserve-baselines=3" in argv
    assert "--pfsp-epsilon=0.05" in argv
    assert "--pfsp-k=2.0" in argv


def test_no_league_flags_without_snapshot_manifest():
    # Empty-pool fixed-field mode (task A): the league/PFSP flags must NOT appear, so draw() keeps
    # returning the cycled --opponents field and the server's own defaults govern.
    argv = _argv(reserve_baselines=9, pfsp_epsilon=0.5, pfsp_k=1.0)
    joined = " ".join(argv)
    assert "--snapshot-manifest" not in joined
    assert "--snapshot-pool-cap" not in joined
    assert "--reserve-baselines" not in joined
    assert "--pfsp-epsilon" not in joined
    assert "--pfsp-k" not in joined
