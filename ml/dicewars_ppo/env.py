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

**Reward** — sparse terminal-win by default ([D-19] decision 3): ``+1`` if the
learner won, else ``0``; ``0`` on every non-terminal step. The persona roster
(``docs/ml-bot/PERSONAS.md``) selects an alternate terminal objective via
``reward_mode`` (``"placement"`` = Survivor) and/or a win-gated
``terminal_speed_bonus`` (Blitz) — see :func:`terminal_reward`. All such modes
read wire fields already present, so they are wire-contract-free (no
``ENCODING_VERSION`` bump); the defaults are byte-identical to the sparse win.
The two DENSE personas add a per-step shaping reward (bite G): ``territory_reward_coef``
(Expansionist) and ``elim_bounty`` (Predator), applied via :func:`step_reward` on every
step (incl. the terminal) from the shaped wire's raw ``delta_territory``/``elims_by_learner``
fields. A non-zero coef flips the env to parse shaped frames and tells the managed server to
emit them (``reward_shaping`` server kwarg); both default 0 ⇒ base wire, byte-identical to today.

**Episode model.** The server streams episodes back-to-back over one connection:
a run of obs frames (``terminal == 0``), each answered with an action, then one
terminal frame (``terminal == 1``, no reply), then immediately the next episode's
first obs. So :meth:`reset` reads "the next obs frame" and :meth:`step` reads the
frame that follows the action — uniform across the first and subsequent episodes.
"""

from __future__ import annotations

import math
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

REWARD_MODES = ("win", "placement")


def terminal_reward(
    *,
    won: int,
    placement: float,
    turn_number: int,
    truncated: int = 0,
    reward_mode: str = "win",
    speed_bonus: float = 0.0,
    speed_ref: int | None = None,
) -> float:
    """The terminal-frame reward from already-validated wire fields (pure → lean-testable).

    Every input (``won``/``placement``/``turn_number``/``truncated``) is already on the obs-frame
    wire today, so all of these modes are **wire-contract-free** — no ``ENCODING_VERSION`` bump.
    The persona roster (``docs/ml-bot/PERSONAS.md``) uses this to specialize play-style without
    touching the encoder.

    Modes:
      - ``"win"`` — sparse terminal-win (``+1`` win else ``0``), the [D-19] default (Conqueror).
      - ``"placement"`` — the scaled finishing rank in ``[0, 1]`` (1=first … 0=last) — the
        Survivor objective (the "ELO trap" [D-19] avoided for the gate bot, repurposed here).

    A ``maxTurns`` stalemate cap (``truncated``) pays **0 in every mode**. The cap is an artificial
    Gym truncation, not a realized outcome, so ``step()`` bootstraps ``V(s)`` there (it returns
    ``truncated=True``). Paying a non-zero terminal reward too — the rank-at-cap that ``placement``
    mode would otherwise yield — AND bootstrapping would *double-count* the outcome (the value head
    already estimates the eventual placement) and bias the Survivor toward stalling to the cap.
    ``win`` mode is 0 here regardless (a cap can't be a win, enforced upstream by ``step()``), so
    the early return only changes the ``placement`` path; it keeps truncation handling uniform.

    Optional bounded terminal SPEED bonus (Blitz's secondary lever; lower ``--gamma`` first)::

        reward *= 1 + speed_bonus * clip(1 - turn_number / speed_ref, 0, 1)

    It is **multiplicative and win-gated**: a faster WIN is worth strictly more, while a loss is
    untouched. An additive per-step time PENALTY would instead let the bot throw games just to
    end them sooner — exactly why [D-19] keeps the base reward sparse and lets time only scale a
    win. ``speed_ref`` must be a positive turn count when ``speed_bonus > 0`` (callers validate).
    """
    if truncated:
        # Artificial cap → no realized outcome; step() bootstraps V(s). A non-zero payout here
        # would double-count placement and reward stalling to the cap (see docstring).
        return 0.0
    base = float(placement) if reward_mode == "placement" else float(won)
    if speed_bonus > 0.0 and won:
        # speed_ref is positive when speed_bonus > 0 — callers validate (DiceWarsEnv.__init__ /
        # validate_reward_args); a direct call that breaks this raises TypeError/ZeroDivisionError.
        frac = 1.0 - (turn_number / speed_ref)
        frac = min(1.0, max(0.0, frac))  # clip to [0, 1]: no bonus once turn_number >= speed_ref
        base *= 1.0 + speed_bonus * frac
    return base


def step_reward(
    *,
    delta_territory: float,
    elims_by_learner: int,
    territory_coef: float = 0.0,
    elim_bounty: float = 0.0,
    clip: float | None = None,
) -> float:
    """The dense per-step reward from the shaped wire's RAW measurements (pure → lean-testable).

    The persona roster's two DENSE objectives (``docs/ml-bot/PERSONAS.md`` §4, bite G), applied
    on every step including the terminal:

      - **Expansionist** — ``territory_coef`` × net learner-territory change since the prior
        decision (``delta_territory``). The env-server measures NET change, so the
        capture-then-lose ping-pong hack (§6) nets 0; land lost — including the learner's own
        elimination, where its count drops to 0 — is a negative signal, the honest cost of
        overextending.
      - **Predator** — ``elim_bounty`` × players the learner eliminated since the prior decision
        (``elims_by_learner`` ≥ 0). Rewards taking the kill, including the game-ending one.

    Both coefficients default to 0, so an unshaped run (the [D-19]/Conqueror default) returns 0.0
    every step — identical to today. ``clip`` (§6 "cap per-turn") bounds the per-step shaping
    magnitude to ``[-clip, +clip]`` when set — capping the variance a big swing injects (e.g. the
    territory wipe on the learner's elimination); ``None`` leaves it unbounded.
    """
    reward = territory_coef * float(delta_territory) + elim_bounty * float(elims_by_learner)
    if clip is not None:
        reward = min(clip, max(-clip, reward))
    return reward


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
        read_timeout_s: float = 180.0,
        # Reward shaping (persona roster, docs/ml-bot/PERSONAS.md). All wire-free (see
        # terminal_reward); the defaults reproduce the [D-19] sparse terminal-win exactly.
        reward_mode: str = "win",
        terminal_speed_bonus: float = 0.0,
        speed_ref: int | None = None,
        # Dense per-step shaping (bite G — Expansionist/Predator). Both default 0 ⇒ no shaping ⇒
        # base (unshaped) wire, byte-identical to the sparse-win path. A non-zero coef flips the
        # env to parse shaped frames AND tells the managed server to emit them (see below).
        territory_reward_coef: float = 0.0,
        elim_bounty: float = 0.0,
        shaping_clip: float | None = None,
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
        self._read_timeout_s = read_timeout_s

        if reward_mode not in REWARD_MODES:
            raise ValueError(f"reward_mode must be one of {REWARD_MODES}, got {reward_mode!r}")
        if terminal_speed_bonus < 0.0:
            raise ValueError(f"terminal_speed_bonus must be >= 0 (got {terminal_speed_bonus})")
        if terminal_speed_bonus > 0.0 and not (speed_ref is not None and speed_ref > 0):
            raise ValueError(
                f"speed_ref must be a positive int when terminal_speed_bonus > 0 (got {speed_ref})"
            )
        self._reward_mode = reward_mode
        self._speed_bonus = float(terminal_speed_bonus)
        self._speed_ref = speed_ref

        # Dense shaping coefs (bite G). Both non-negative + finite: a kill is always good (bounty
        # >= 0) and more net territory is always good (coef >= 0); a clip, when set, must be > 0.
        if not (math.isfinite(territory_reward_coef) and territory_reward_coef >= 0.0):
            raise ValueError(
                f"territory_reward_coef must be a finite number >= 0 (got {territory_reward_coef})"
            )
        if not (math.isfinite(elim_bounty) and elim_bounty >= 0.0):
            raise ValueError(f"elim_bounty must be a finite number >= 0 (got {elim_bounty})")
        if shaping_clip is not None and not (math.isfinite(shaping_clip) and shaping_clip > 0.0):
            raise ValueError(
                f"shaping_clip must be a finite number > 0 when set (got {shaping_clip})"
            )
        self._territory_coef = float(territory_reward_coef)
        self._elim_bounty = float(elim_bounty)
        self._shaping_clip = shaping_clip
        # Shaped iff a dense coef is active. Drives both the wire-parse variant and (for a managed
        # server) the --reward-shaping forward below; off ⇒ everything is byte-identical to today.
        self._shaped = self._territory_coef > 0.0 or self._elim_bounty > 0.0

        if not managed and (host is None or port is None):
            raise ValueError("managed=False requires explicit host and port.")
        if managed:
            # The env owns these dims, so pin the server to the same ones.
            self._server_kwargs.setdefault("players", player_count)
            self._server_kwargs.setdefault("max_areas", max_areas)
            # Tell the managed server to EMIT shaped frames when a dense persona is active. (For an
            # unmanaged server the caller is responsible for launching it with --reward-shaping=1;
            # a mismatch is caught loudly by the frame-length guard in parse_frame.)
            if self._shaped:
                self._server_kwargs.setdefault("reward_shaping", True)

        self._server: EnvServerProcess | None = None
        self._sock: socket.socket | None = None
        # The legal/pad mask of the LAST observation handed out — what
        # action_masks() returns and what step() validates the action against.
        self._mask = np.zeros(self.max_edges, dtype=bool)
        self._awaiting_reset = True  # gym contract: must reset() before step()
        # Tight upper bound on a legal frame body (num_edges ≤ max_edges); recv_frame
        # rejects a larger length prefix as a desync instead of buffering it. Accounts for the
        # +8-byte shaped header tail so a shaped run's max isn't undersized.
        self._max_frame_bytes = expected_frame_bytes(
            max_areas, player_count, max_edges, shaped=self._shaped
        )

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
            # A finite per-recv read deadline (not None) so a wedged env-server surfaces as a loud
            # socket.timeout instead of an infinite client hang. The server's OWN decision watchdog
            # only covers a hung learner (it parks in Atomics.wait inside chooseAction); it cannot
            # catch an opponent bot stuck in a synchronous compute loop, because then the server's
            # main thread never reaches chooseAction. This client deadline is the backstop for that
            # case. Generous: >> any legal inter-frame gap (a full opponent round is sub-second).
            sock.settimeout(self._read_timeout_s)
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

        frame = recv_frame(self._sock, self._max_frame_bytes, shaped=self._shaped)
        if frame.is_terminal:
            raise RuntimeError(
                "env-server sent a terminal frame at reset() — episode desync "
                "(expected the first decision of a new episode)."
            )
        self._awaiting_reset = False
        return self._frame_to_obs(frame), self._info(frame)

    def step(self, action: int) -> tuple[dict[str, np.ndarray], float, bool, bool, dict[str, Any]]:
        if self._awaiting_reset:
            raise RuntimeError("step() called before reset() (or after a terminal step).")
        action = int(action)
        if not (0 <= action < self.max_edges) or not self._mask[action]:
            raise ValueError(
                f"illegal action {action}: not in the legal set "
                f"{np.flatnonzero(self._mask).tolist()} — MaskablePPO must mask the pad tail."
            )

        send_action(self._sock, action)
        frame = recv_frame(self._sock, self._max_frame_bytes, shaped=self._shaped)

        if frame.is_terminal:
            # Terminal reward — sparse win by default ([D-19] decision 3); persona modes
            # (placement / speed bonus) are selected via `terminal_reward`. Validate the wire
            # values so an encoder/server regression fails loud here instead of feeding a
            # poisoned reward into the replay buffer.
            if frame.won not in (0, 1):
                raise ValueError(
                    f"terminal frame won={frame.won} not in {{0, 1}} — wire corruption?"
                )
            if not 0.0 <= frame.placement <= 1.0:
                raise ValueError(f"terminal frame placement={frame.placement} not in [0, 1]")
            if frame.truncated not in (0, 1):
                raise ValueError(
                    f"terminal frame truncated={frame.truncated} not in {{0, 1}} — wire corruption?"
                )
            # A win and a maxTurns truncation are mutually exclusive: a stalemate cap means the
            # game did not end, so it cannot also be a win. Each flag is individually in-range
            # above, but the contradictory pair (won=1, truncated=1) would still slip through and
            # bootstrap a win's value target (terminated=False) — poisoning the critic. Reject it
            # loud here rather than trust the JS side to keep them exclusive.
            if frame.truncated and frame.won:
                raise ValueError(
                    f"terminal frame is both truncated and won (won={frame.won}, "
                    f"truncated={frame.truncated}) — a maxTurns stalemate cap cannot be a win; "
                    "summarizeOutcome regression or wire corruption?"
                )
            reward = terminal_reward(
                won=frame.won,
                placement=frame.placement,
                turn_number=frame.turn_number,
                truncated=frame.truncated,
                reward_mode=self._reward_mode,
                speed_bonus=self._speed_bonus,
                speed_ref=self._speed_ref,
            )
            # The dense personas (bite G) ALSO pay the last realized interval at the terminal: the
            # net territory change up to the end and any game-ending kill (Predator's winning
            # elimination). This is an immediate per-step reward, orthogonal to the bootstrap below
            # — unlike the terminal OUTCOME reward, it is paid on a truncation too (it is realized,
            # not the artificial cap's would-be placement that terminal_reward zeroes to avoid
            # double-counting with V(s)).
            if self._shaped:
                reward += self._step_shaping(frame)
            # A maxTurns stalemate cap is a Gym TRUNCATION, not a real terminal: the game did
            # not actually end, so SB3 must bootstrap V(s) here (it keys off `truncated` via the
            # gym→VecEnv shim's `TimeLimit.truncated` info). A win or the learner's elimination is
            # a genuine terminal (`terminated`, bootstrap 0). The two are mutually exclusive here.
            truncated = bool(frame.truncated)
            terminated = not truncated
            self._awaiting_reset = True
            return self._frame_to_obs(frame), reward, terminated, truncated, self._info(frame)

        # Non-terminal: 0 by default; the dense personas add a per-step shaping reward read from
        # the shaped wire fields (Expansionist territory delta / Predator kill bounty).
        step_r = self._step_shaping(frame) if self._shaped else 0.0
        return self._frame_to_obs(frame), step_r, False, False, self._info(frame)

    def _step_shaping(self, frame: ObsFrame) -> float:
        """Validate the shaped wire fields, then apply the persona reward weights (bite G).

        Validates on EVERY shaped frame (not just terminal, unlike the won/placement guards) so a
        server/encoder regression that poisons a dense reward fails loud here instead of silently
        feeding garbage into the replay buffer.
        """
        if frame.elims_by_learner < 0:
            raise ValueError(
                f"frame elims_by_learner={frame.elims_by_learner} < 0 — wire corruption?"
            )
        if not math.isfinite(frame.delta_territory):
            raise ValueError(
                f"frame delta_territory={frame.delta_territory} not finite — wire corruption?"
            )
        return step_reward(
            delta_territory=frame.delta_territory,
            elims_by_learner=frame.elims_by_learner,
            territory_coef=self._territory_coef,
            elim_bounty=self._elim_bounty,
            clip=self._shaping_clip,
        )

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
            "truncated": frame.truncated,
            "placement": frame.placement,
            "num_edges": frame.num_edges,
            "active_player_id": frame.active_player_id,
            "turn_number": frame.turn_number,
            # Dense-reward raw signals (bite G); 0 on a base/unshaped frame.
            "delta_territory": frame.delta_territory,
            "elims_by_learner": frame.elims_by_learner,
        }
