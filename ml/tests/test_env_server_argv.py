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


def test_persistence_flags_forwarded_when_set():
    # Task E (B6 Python forwarding): the persistence trio rides its own gate, independent of the
    # snapshot manifest — a fixed-field run with NO manifest still checkpoints/resumes.
    argv = _argv(
        snapshot_store="disk",
        league_state_dir="/run/league-state",
        league_dump_every=25,
    )
    assert "--snapshot-store=disk" in argv
    assert "--league-state-dir=/run/league-state" in argv
    assert "--league-dump-every=25" in argv
    # No snapshot manifest was given, yet persistence flags still appear (manifest-independent).
    assert "--snapshot-manifest" not in " ".join(argv)


def test_persistence_flags_absent_when_unset():
    # The point of the None defaults: an opt-out run is byte-identical to B5 (Node uses its own
    # defaults — snapshot-store=memory, league-dump-every=50, persistence off).
    joined = " ".join(_argv())
    assert "--snapshot-store" not in joined
    assert "--league-state-dir" not in joined
    assert "--league-dump-every" not in joined


def test_persistence_flags_coexist_with_pfsp_flags():
    # A real task-E PFSP launch sets BOTH the snapshot manifest (PFSP pool) AND persistence (disk
    # store + state dir). Both groups must appear without interfering.
    argv = _argv(
        snapshot_manifest="/tmp/snap/manifest.json",
        snapshot_store="disk",
        league_state_dir="/tmp/snap",
        league_dump_every=50,
    )
    assert "--snapshot-manifest=/tmp/snap/manifest.json" in argv
    assert "--snapshot-store=disk" in argv
    assert "--league-state-dir=/tmp/snap" in argv
    assert "--league-dump-every=50" in argv


def test_reward_shaping_flag_forwarded_when_enabled():
    # Bite G: a dense-persona env tells its managed server to EMIT shaped frames. The flag is the
    # ONLY thing that makes the wire grow, so its forwarding is the bridge guard for the dense path.
    assert "--reward-shaping=1" in _argv(reward_shaping=True)


def test_reward_shaping_flag_absent_by_default():
    # Off by default ⇒ argv byte-identical to today and the Node server stays on the base (unshaped)
    # wire — the B5/B6 opt-in discipline.
    assert "--reward-shaping" not in " ".join(_argv())
    assert "--reward-shaping" not in " ".join(_argv(reward_shaping=False))
