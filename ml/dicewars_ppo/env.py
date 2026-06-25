"""``DiceWarsEnv`` — a single-agent Gymnasium env over the Node env-server.

The learner is one seat; the env-server runs the other seats in-process in Node
and exposes only the learner's decisions to Python (see the package docstring for
why this is single-agent, not PettingZoo AEC). One ``DiceWarsEnv`` owns one
socket to one ``ppo-env-server.mjs`` process; a vectorized trainer
(``SubprocVecEnv``) instantiates N of them.

**Action space** — ``Discrete(MAX_EDGES)``. A live decision has ``num_edges``
legal entries (legal attacks + a trailing STOP); the env pads to ``MAX_EDGES``
and exposes the legal/pad split via :meth:`action_masks` (sb3-contrib
``MaskablePPO`` reads it) and the ``edge_mask`` field of the observation. The
chosen index is sent verbatim to the server, which decodes it against its own
``moves[]`` (index ``num_edges - 1`` == STOP == ``END_TURN``).

**Observation** — a ``Dict`` of the v2 encoding tensors, edges padded to
``MAX_EDGES``: ``nodes`` ``[max_areas, 8]``, ``players`` ``[player_count, 6]``,
``board`` ``[5]``, ``edge_feat`` ``[MAX_EDGES, 7]``, ``edge_from``/``edge_to``
``[MAX_EDGES]`` (territory ids, pad → 0), ``edge_mask`` ``[MAX_EDGES]`` (1 legal).

**Reward** — sparse terminal-win only ([D-19] decision 3): ``+1`` if the learner
won, else ``0``; ``0`` on every non-terminal step. Potential-based shaping is a
later step and is deliberately NOT here.

**Episode model.** The server streams episodes back-to-back over one connection:
a run of obs frames (``terminal == 0``), each answered with an action, then one
terminal frame (``terminal == 1``, no reply), then immediately the next episode's
first obs. So :meth:`reset` reads "the next obs frame" and :meth:`step` reads the
frame that follows the action — uniform across the first and subsequent episodes.
"""

from __future__ import annotations

import socket
from typing import Any

import gymnasium as gym
import numpy as np
from gymnasium import spaces

from .constants import (
    BOARD_W,
    DEFAULT_MAX_AREAS,
    DEFAULT_PLAYER_COUNT,
    EDGE_W,
    MAX_EDGES,
    NODE_W,
    PLAYER_W,
)
from .env_server import EnvServerProcess
from .wire import ObsFrame, expected_frame_bytes, recv_frame, send_action


class DiceWarsEnv(gym.Env):
    """Single-agent masked env wrapping one Node self-play env-server."""

    metadata = {"render_modes": []}

    def __init__(
        self,
        *,
        max_areas: int = DEFAULT_MAX_AREAS,
        player_count: int = DEFAULT_PLAYER_COUNT,
        max_edges: int = MAX_EDGES,
        # Server lifecycle: either launch one (managed=True, the default) or
        # connect to an already-listening server at (host, port).
        managed: bool = True,
        host: str | None = None,
        port: int | None = None,
        server_kwargs: dict[str, Any] | None = None,
        connect_timeout_s: float = 30.0,
    ) -> None:
        super().__init__()
        self.max_areas = max_areas
        self.player_count = player_count
        self.max_edges = max_edges
        self._managed = managed
        self._host = host
        self._port = port
        self._server_kwargs = dict(server_kwargs or {})
        self._connect_timeout_s = connect_timeout_s

        if not managed and (host is None or port is None):
            raise ValueError("managed=False requires explicit host and port.")
        if managed:
            # The env owns these dims, so pin the server to the same ones.
            self._server_kwargs.setdefault("players", player_count)
            self._server_kwargs.setdefault("max_areas", max_areas)

        self._server: EnvServerProcess | None = None
        self._sock: socket.socket | None = None
        # The legal/pad mask of the LAST observation handed out — what
        # action_masks() returns and what step() validates the action against.
        self._mask = np.zeros(self.max_edges, dtype=bool)
        self._awaiting_reset = True  # gym contract: must reset() before step()
        # Tight upper bound on a legal frame body (num_edges ≤ max_edges); recv_frame
        # rejects a larger length prefix as a desync instead of buffering it.
        self._max_frame_bytes = expected_frame_bytes(max_areas, player_count, max_edges)

        self.action_space = spaces.Discrete(self.max_edges)
        self.observation_space = spaces.Dict(
            {
                "nodes": spaces.Box(-np.inf, np.inf, (max_areas, NODE_W), np.float32),
                "players": spaces.Box(-np.inf, np.inf, (player_count, PLAYER_W), np.float32),
                "board": spaces.Box(-np.inf, np.inf, (BOARD_W,), np.float32),
                "edge_feat": spaces.Box(-np.inf, np.inf, (max_edges, EDGE_W), np.float32),
                "edge_from": spaces.Box(0, max_areas, (max_edges,), np.int32),
                "edge_to": spaces.Box(0, max_areas, (max_edges,), np.int32),
                "edge_mask": spaces.MultiBinary(max_edges),
            }
        )

    # --- connection management ------------------------------------------------

    def _ensure_connected(self) -> None:
        if self._sock is not None:
            return
        if self._managed:
            self._server = EnvServerProcess(**self._server_kwargs).start()
            host, port = self._server.host, self._server.port
        else:
            host, port = self._host, self._port
        try:
            sock = socket.create_connection((host, port), timeout=self._connect_timeout_s)
            sock.settimeout(None)  # blocking reads for the rest of the episode
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError as exc:
            # Reap the just-launched managed server so a failed connect can't orphan it,
            # and fold in its exit code (often the real cause) instead of a bare refusal.
            rc = self._server.returncode if self._server is not None else None
            self.close()
            raise ConnectionError(
                f"failed to connect to env-server at {host}:{port} "
                f"(managed server returncode={rc}): {exc}"
            ) from exc
        self._sock = sock

    # --- gym API --------------------------------------------------------------

    def reset(
        self, *, seed: int | None = None, options: dict | None = None
    ) -> tuple[dict[str, np.ndarray], dict[str, Any]]:
        # Episode seeding is owned by the server (--seed-base + episode counter),
        # so `seed` can't reseed a running server; accept it for API compatibility.
        super().reset(seed=seed)
        self._ensure_connected()

        frame = recv_frame(self._sock, self._max_frame_bytes)
        if frame.is_terminal:
            raise RuntimeError(
                "env-server sent a terminal frame at reset() — episode desync "
                "(expected the first decision of a new episode)."
            )
        self._awaiting_reset = False
        return self._frame_to_obs(frame), self._info(frame)

    def step(
        self, action: int
    ) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        if self._awaiting_reset:
            raise RuntimeError("step() called before reset() (or after a terminal step).")
        action = int(action)
        if not (0 <= action < self.max_edges) or not self._mask[action]:
            raise ValueError(
                f"illegal action {action}: not in the legal set "
                f"{np.flatnonzero(self._mask).tolist()} — MaskablePPO must mask the pad tail."
            )

        send_action(self._sock, action)
        frame = recv_frame(self._sock, self._max_frame_bytes)

        if frame.is_terminal:
            # Sparse terminal-win reward ([D-19] decision 3). Validate the wire values
            # so an encoder/server regression fails loud here instead of feeding a
            # poisoned reward into the replay buffer.
            if frame.won not in (0, 1):
                raise ValueError(
                    f"terminal frame won={frame.won} not in {{0, 1}} — wire corruption?"
                )
            if not 0.0 <= frame.placement <= 1.0:
                raise ValueError(f"terminal frame placement={frame.placement} not in [0, 1]")
            reward = float(frame.won)
            # All terminals are reported `terminated` for now; distinguishing a
            # maxTurns stalemate as `truncated` (for value bootstrapping) needs a
            # truncation flag on the wire — a later refinement (not yet a PLAN step).
            self._awaiting_reset = True
            return self._frame_to_obs(frame), reward, True, False, self._info(frame)

        return self._frame_to_obs(frame), 0.0, False, False, self._info(frame)

    def action_masks(self) -> np.ndarray:
        """The boolean legal-action mask of the current observation (sb3-contrib).

        Returns ``bool`` (what MaskablePPO's ``MaskableCategorical`` expects); the
        same mask rides in the observation as ``edge_mask`` in ``int8`` (the dtype
        ``MultiBinary`` requires). The two dtypes are intentional, not a mismatch.
        """
        return self._mask.copy()

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None
        if self._server is not None:
            self._server.close()
            self._server = None

    # --- helpers --------------------------------------------------------------

    def _frame_to_obs(self, frame: ObsFrame) -> dict[str, np.ndarray]:
        self._check_dims(frame)
        n = frame.num_edges

        edge_feat = np.zeros((self.max_edges, EDGE_W), dtype=np.float32)
        edge_from = np.zeros(self.max_edges, dtype=np.int32)
        edge_to = np.zeros(self.max_edges, dtype=np.int32)
        mask = np.zeros(self.max_edges, dtype=np.int8)

        edge_feat[:n] = frame.edges
        edge_from[:n] = frame.edge_index[:, 0]
        edge_to[:n] = frame.edge_index[:, 1]
        mask[:n] = 1

        self._mask = mask.astype(bool)
        return {
            "nodes": frame.nodes,
            "players": frame.players,
            "board": frame.board,
            "edge_feat": edge_feat,
            "edge_from": edge_from,
            "edge_to": edge_to,
            "edge_mask": mask,
        }

    def _check_dims(self, frame: ObsFrame) -> None:
        if frame.max_areas != self.max_areas:
            raise ValueError(f"frame max_areas {frame.max_areas} != env {self.max_areas}")
        if frame.player_count != self.player_count:
            raise ValueError(f"frame player_count {frame.player_count} != env {self.player_count}")
        if frame.num_edges < 1:
            raise ValueError(f"frame num_edges {frame.num_edges} < 1 (STOP must exist)")
        if frame.num_edges > self.max_edges:
            # An overflow means MAX_EDGES is too small for this board ([D-20]
            # validated p100 ≈ 26 ≪ 64, so this is a real bug, not a normal case).
            raise ValueError(
                f"frame num_edges {frame.num_edges} > MAX_EDGES {self.max_edges} — "
                f"raise MAX_EDGES (and the policy's action space) in lockstep."
            )

    @staticmethod
    def _info(frame: ObsFrame) -> dict[str, Any]:
        return {
            "terminal": frame.terminal,
            "winner": frame.winner,
            "won": frame.won,
            "placement": frame.placement,
            "num_edges": frame.num_edges,
            "active_player_id": frame.active_player_id,
            "turn_number": frame.turn_number,
        }
