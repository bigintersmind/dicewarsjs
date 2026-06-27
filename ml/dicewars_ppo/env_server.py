"""Launch + supervise a ``scripts/ppo-env-server.mjs`` subprocess.

The env-server is a persistent Node process that runs the self-play match
(learner seat external, all opponents in-process) and speaks the binary socket
protocol in ``wire``. This module just owns its lifecycle: spawn it on an
OS-assigned port (``--port=0``), parse the ``PPO_ENV_SERVER LISTENING <host>
<port>`` line it prints to learn where to connect, and tear it down cleanly.

A background reader thread drains the server's stdout so its (tiny) ``LISTENING``
/ ``DONE`` output can never fill the pipe buffer and stall the server; stderr is
inherited so server-side errors surface in the trainer's logs.

One server == one learner connection (the server rejects a second), so a
vectorized trainer (``SubprocVecEnv``) launches one ``EnvServerProcess`` per env.
"""

from __future__ import annotations

import queue
import re
import shutil
import subprocess
import threading
import weakref
from pathlib import Path

# ml/dicewars_ppo/env_server.py → parents[2] == repo root.
REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_SCRIPT = REPO_ROOT / "scripts" / "ppo-env-server.mjs"

_LISTENING_RE = re.compile(r"^PPO_ENV_SERVER LISTENING (\S+) (\d+)\s*$")

# Sentinel the stdout reader pushes when the server's stdout reaches EOF without
# ever announcing LISTENING — i.e. it died on startup (bad node, import error). It
# lets start() fail fast instead of waiting out the full start_timeout_s.
_STARTUP_FAILED = object()


def _terminate_proc(proc: subprocess.Popen) -> None:
    """Best-effort reap: SIGTERM, wait briefly, SIGKILL if it ignores it.

    Module-level (not a bound method) so it can back a ``weakref.finalize`` without
    keeping the owning ``EnvServerProcess`` alive. Never raises — a wedged child can't
    be helped by blocking forever — so it's safe on ``start()``'s failure path, where a
    reap exception would otherwise mask the descriptive ``EnvServerError``. Idempotent
    and safe on an already-exited process (``poll()`` short-circuits).
    """
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass  # unkillable child; nothing more we can do without blocking forever


class EnvServerError(RuntimeError):
    """The env-server failed to start, list, or exited unexpectedly."""


class EnvServerProcess:
    """A spawned ``ppo-env-server.mjs``; a context manager that reaps on exit.

    Args mirror the server's CLI flags (see ``scripts/ppo-env-server.mjs``).
    ``episodes=0`` (the training default) runs until the client disconnects.
    """

    def __init__(
        self,
        *,
        players: int = 7,
        learner_seat: int = 0,
        opponents: str = "ai_lookahead",
        max_areas: int | None = None,
        max_turns: int = 500,
        episodes: int = 0,
        seed_base: int = 1,
        decision_timeout_ms: int = 120_000,
        snapshot_manifest: str | None = None,
        snapshot_pool_cap: int = 40,
        reserve_baselines: int = 3,
        pfsp_epsilon: float = 0.05,
        pfsp_k: float = 2.0,
        host: str = "127.0.0.1",
        node_bin: str | None = None,
        start_timeout_s: float = 30.0,
    ) -> None:
        self._start_timeout_s = start_timeout_s
        self.host: str | None = None
        self.port: int | None = None
        self._proc: subprocess.Popen | None = None
        self._reader: threading.Thread | None = None
        self._finalizer: weakref.finalize | None = None
        # Exit code captured at close() so `returncode` survives teardown (_proc → None).
        self._returncode: int | None = None
        # Holds the parsed (host, port) tuple, or _STARTUP_FAILED on a startup crash.
        self._listening: queue.Queue = queue.Queue(maxsize=1)

        node = node_bin or shutil.which("node")
        if node is None:
            raise EnvServerError("`node` not found on PATH — needed to run the env-server.")
        if not SERVER_SCRIPT.is_file():
            raise EnvServerError(f"env-server script not found at {SERVER_SCRIPT}.")

        argv = [
            node,
            str(SERVER_SCRIPT),
            "--port=0",
            f"--host={host}",
            f"--players={players}",
            f"--learner-seat={learner_seat}",
            f"--opponents={opponents}",
            f"--max-turns={max_turns}",
            f"--episodes={episodes}",
            f"--seed-base={seed_base}",
            f"--decision-timeout-ms={decision_timeout_ms}",
        ]
        if max_areas is not None:
            argv.append(f"--max-areas={max_areas}")
        # PFSP snapshot pool (B3): point the server's league at the producer manifest and bound its
        # live pool. Absent ⇒ the server runs in empty-pool fixed-field mode (task A / B1 / B2).
        # The PFSP sampler knobs (B4) only bite once that pool is non-empty, so they ride the same
        # branch — in fixed-field mode `draw()` ignores them and the env-server defaults suffice.
        if snapshot_manifest is not None:
            argv.append(f"--snapshot-manifest={snapshot_manifest}")
            argv.append(f"--snapshot-pool-cap={snapshot_pool_cap}")
            argv.append(f"--reserve-baselines={reserve_baselines}")
            argv.append(f"--pfsp-epsilon={pfsp_epsilon}")
            argv.append(f"--pfsp-k={pfsp_k}")
        self._argv = argv

    def start(self) -> EnvServerProcess:
        """Spawn the server and block until it prints its LISTENING line."""
        # stderr inherited (errors visible); stdout piped + drained by the reader.
        self._proc = subprocess.Popen(  # noqa: S603 - argv built from our own constants
            self._argv,
            cwd=str(REPO_ROOT),
            stdout=subprocess.PIPE,
            stderr=None,
            text=True,
            bufsize=1,
        )
        # GC backstop: if this instance is dropped without close() (e.g. a trainer
        # crash mid-sweep), still reap the Node child instead of orphaning it.
        self._finalizer = weakref.finalize(self, _terminate_proc, self._proc)
        self._reader = threading.Thread(target=self._drain_stdout, daemon=True)
        self._reader.start()

        try:
            got = self._listening.get(timeout=self._start_timeout_s)
        except queue.Empty as exc:
            self.close()
            raise EnvServerError(
                f"env-server did not report LISTENING within {self._start_timeout_s}s "
                f"(args: {' '.join(self._argv[2:])})"
            ) from exc
        if got is _STARTUP_FAILED:
            rc = self._proc.poll() if self._proc else None
            self.close()
            raise EnvServerError(
                f"env-server exited before listening (returncode={rc}) — check the server's "
                f"stderr above (args: {' '.join(self._argv[2:])})."
            )
        self.host, self.port = got
        return self

    def _drain_stdout(self) -> None:
        """Capture the LISTENING line; discard the rest so the pipe never fills.

        On EOF without ever seeing LISTENING (the server crashed on startup), push
        the _STARTUP_FAILED sentinel so start() fails fast instead of timing out. Any
        unexpected reader error (e.g. a decode error on the pipe) is funneled to the
        same sentinel via `finally`, so a dead reader thread can't strand start() on
        its full timeout with a misleading "did not report LISTENING" message.
        """
        assert self._proc is not None and self._proc.stdout is not None
        seen = False
        try:
            for line in self._proc.stdout:
                if not seen:
                    m = _LISTENING_RE.match(line)
                    if m:
                        seen = True
                        self._listening.put((m.group(1), int(m.group(2))))
                # Other lines (e.g. `PPO_ENV_SERVER DONE …`) are intentionally dropped.
        finally:
            if not seen:
                self._listening.put(_STARTUP_FAILED)

    @property
    def returncode(self) -> int | None:
        # After close() the proc handle is gone; fall back to the code captured then.
        return self._proc.poll() if self._proc is not None else self._returncode

    def close(self) -> None:
        """Terminate the server and reap it; idempotent and never raises.

        The reap (SIGTERM→SIGKILL) is delegated to ``_terminate_proc`` via the
        finalizer, so a wedged child can't surface a ``TimeoutExpired`` that would mask
        the descriptive ``EnvServerError`` raised on ``start()``'s failure path (which
        calls ``close()`` before re-raising).
        """
        proc = self._proc
        if proc is None:
            return
        if self._finalizer is not None:
            self._finalizer()  # runs _terminate_proc(proc); marks the GC backstop spent
        else:
            _terminate_proc(proc)
        self._returncode = proc.poll()
        self._proc = None

    def __enter__(self) -> EnvServerProcess:
        return self.start()

    def __exit__(self, *exc) -> None:
        self.close()
