"""Binary observation-frame codec + length-prefixed socket framing.

A Python port of ``scripts/lib/obs-frame.mjs`` (parse) and its serializer
(``serializeObsFrame``, mirrored here for hermetic round-trip tests / debugging).
The byte layout is documented in obs-frame.mjs; the short version:

    HEADER  48 bytes  — 11 × i32 then placement f32 (see constants.HEADER_STRUCT)
                        (the 11th i32 is `truncated`: 1 = maxTurns stalemate cap)
                        (+8-byte dense-reward tail under `shaped=True`, "bite G":
                         deltaTerritory f32 then elimsByLearner i32 — see
                         constants.HEADER_STRUCT_SHAPED. Off by default ⇒ 48 bytes.)
    nodes      f32  maxAreas   × NODE_W
    players    f32  playerCount × PLAYER_W
    board      f32  BOARD_W
    edges      f32  numEdges   × EDGE_W        (last row = STOP, isStop@col 3)
    edge_index i32  numEdges   × 2  (fromId, toId)   (STOP row = [0, 0])

Wire protocol over the socket (Node is the SERVER; this learner connects):

    OUT (env → learner): [u32 LE byteLength][frame bytes]   (length-prefixed)
    IN  (learner → env): one i32 LE action index per non-terminal frame (no prefix)

Terminal frames (header ``terminal == 1``) carry the episode reward and expect
NO reply.

The parser validates magic, ``encodingVersion``, and the exact byte length
against the header dims, so a mis-sized or mis-versioned frame fails loudly here
instead of silently mis-``reshape``-ing downstream (mirrors the JS parser).
"""

from __future__ import annotations

import socket as _socket
import struct
from dataclasses import dataclass

import numpy as np

from .constants import (
    BOARD_W,
    EDGE_W,
    ENCODING_VERSION,
    F32,
    HEADER_BYTES,
    HEADER_BYTES_SHAPED,
    HEADER_STRUCT,
    HEADER_STRUCT_SHAPED,
    I32,
    NODE_W,
    OBS_FRAME_MAGIC,
    PLAYER_W,
)

_ACTION_STRUCT = struct.Struct("<i")  # one i32 LE action index, no prefix
_LEN_STRUCT = struct.Struct("<I")  # u32 LE outbound length prefix


# eq=False: this DTO is never value-compared, and the default frozen-dataclass
# tuple ``__eq__``/``__hash__`` would raise on the numpy array fields ("ambiguous
# truth value" / "unhashable"). Identity semantics are correct for a per-frame carrier.
@dataclass(frozen=True, eq=False)
class ObsFrame:
    """One decoded observation frame (header fields + tensor payload).

    Tensors are little-endian numpy arrays in the encoder's column order. The
    STOP action is always the last edge row (``edges[-1]``, ``isStop == 1``);
    ``num_edges`` counts legal attacks + that STOP.
    """

    # header
    encoding_version: int
    max_areas: int
    player_count: int
    num_edges: int
    active_player_id: int
    turn_number: int
    terminal: int  # 0 mid-game (action expected), 1 terminal (no reply)
    winner: int  # winning seat, or -1 (none / stalemate)
    won: int  # 1 if the learner won, else 0 (meaningful when terminal == 1)
    truncated: int  # 1 if a maxTurns stalemate CAP (Gym truncation → bootstrap V(s)),
    # else 0 (genuine terminal: win or elimination). Meaningful when terminal == 1.
    placement: float  # scaled 1=first … 0=last (meaningful when terminal == 1)

    # tensors
    nodes: np.ndarray  # [max_areas, NODE_W]  f32
    players: np.ndarray  # [player_count, PLAYER_W]  f32
    board: np.ndarray  # [BOARD_W]  f32
    edges: np.ndarray  # [num_edges, EDGE_W]  f32
    edge_index: np.ndarray  # [num_edges, 2]  i32

    # Dense-reward tail ("bite G"): present only on shaped frames (env-server `--reward-shaping`);
    # 0 on a base frame. RAW per-step measurements — the trainer applies the persona weights.
    delta_territory: float = 0.0  # net learner-territory change since the prior decision frame
    elims_by_learner: int = 0  # learner-attributed eliminations since the prior decision frame

    @property
    def is_terminal(self) -> bool:
        return self.terminal == 1


def expected_frame_bytes(
    max_areas: int, player_count: int, num_edges: int, *, shaped: bool = False
) -> int:
    """Body byte length (no length prefix) for a frame with these dims.

    ``shaped`` accounts for the optional dense-reward header tail ("bite G"): +8 bytes
    (deltaTerritory f32 + elimsByLearner i32). The tensor payload is identical either way.
    """
    floats = max_areas * NODE_W + player_count * PLAYER_W + BOARD_W + num_edges * EDGE_W
    ints = num_edges * 2
    header = HEADER_BYTES_SHAPED if shaped else HEADER_BYTES
    return header + floats * 4 + ints * 4


def parse_frame(buf: bytes | bytearray | memoryview, *, shaped: bool = False) -> ObsFrame:
    """Parse a single frame body (NO length prefix) into an :class:`ObsFrame`.

    ``shaped`` selects the dense-reward header variant ("bite G"): the env-server emits it
    only under ``--reward-shaping`` and a :class:`~dicewars_ppo.env.DiceWarsEnv` configured
    with a persona shaping coefficient parses with ``shaped=True``. The flag MUST match how
    the frame was serialized — a mismatch makes the header size wrong and is caught loudly by
    the byte-length check below (the +8-byte tail can never coincide with a different num_edges
    for the same dims, since one edge is 36 bytes), so a misconfig fails here, never silently.

    Raises:
        ValueError: bad magic, an ``encodingVersion`` mismatch, or a byte length
            inconsistent with the header dims (incl. a shaped/unshaped parse mismatch).
    """
    buf = bytes(buf)
    header_struct = HEADER_STRUCT_SHAPED if shaped else HEADER_STRUCT
    header_bytes = HEADER_BYTES_SHAPED if shaped else HEADER_BYTES
    if len(buf) < header_bytes:
        raise ValueError(
            f"frame is {len(buf)} bytes < {header_bytes}-byte header (shaped={shaped})"
        )

    delta_territory = 0.0
    elims_by_learner = 0
    if shaped:
        (
            magic,
            encoding_version,
            max_areas,
            player_count,
            num_edges,
            active_player_id,
            turn_number,
            terminal,
            winner,
            won,
            truncated,
            placement,
            delta_territory,
            elims_by_learner,
        ) = header_struct.unpack_from(buf, 0)
    else:
        (
            magic,
            encoding_version,
            max_areas,
            player_count,
            num_edges,
            active_player_id,
            turn_number,
            terminal,
            winner,
            won,
            truncated,
            placement,
        ) = header_struct.unpack_from(buf, 0)

    if magic != OBS_FRAME_MAGIC:
        raise ValueError(
            f"bad magic 0x{magic & 0xFFFFFFFF:08x} (expected 0x{OBS_FRAME_MAGIC:08x}) — "
            f"not a DWOB frame or wrong endianness"
        )
    if encoding_version != ENCODING_VERSION:
        raise ValueError(
            f"encodingVersion {encoding_version} != {ENCODING_VERSION}: the JS encoder "
            f"(src/arena/encodeObservation.js) changed the feature layout — bump "
            f"dicewars_ppo.constants.ENCODING_VERSION and the column widths together"
        )

    expected = expected_frame_bytes(max_areas, player_count, num_edges, shaped=shaped)
    if len(buf) != expected:
        raise ValueError(
            f"frame is {len(buf)} bytes, expected {expected} for maxAreas={max_areas} "
            f"playerCount={player_count} numEdges={num_edges} (shaped={shaped})"
        )

    off = header_bytes

    def take_f32(count: int) -> tuple[np.ndarray, int]:
        a = np.frombuffer(buf, dtype=F32, count=count, offset=off)
        return a, off + count * 4

    def take_i32(count: int) -> tuple[np.ndarray, int]:
        a = np.frombuffer(buf, dtype=I32, count=count, offset=off)
        return a, off + count * 4

    nodes, off = take_f32(max_areas * NODE_W)
    players, off = take_f32(player_count * PLAYER_W)
    board, off = take_f32(BOARD_W)
    edges, off = take_f32(num_edges * EDGE_W)
    edge_index, off = take_i32(num_edges * 2)

    # frombuffer returns read-only views into `buf`; copy + reshape so callers
    # (env padding, tests) get writable, independently-shaped arrays.
    return ObsFrame(
        encoding_version=encoding_version,
        max_areas=max_areas,
        player_count=player_count,
        num_edges=num_edges,
        active_player_id=active_player_id,
        turn_number=turn_number,
        terminal=terminal,
        winner=winner,
        won=won,
        truncated=truncated,
        placement=float(placement),
        nodes=nodes.astype(np.float32).reshape(max_areas, NODE_W),
        players=players.astype(np.float32).reshape(player_count, PLAYER_W),
        board=board.astype(np.float32).copy(),
        edges=edges.astype(np.float32).reshape(num_edges, EDGE_W),
        edge_index=edge_index.astype(np.int32).reshape(num_edges, 2),
        delta_territory=float(delta_territory),
        elims_by_learner=int(elims_by_learner),
    )


def serialize_frame(frame: ObsFrame, *, shaped: bool = False) -> bytes:
    """Serialize an :class:`ObsFrame` back to its body bytes (NO length prefix).

    The byte-exact inverse of :func:`parse_frame` — used by the round-trip parity
    test and as a debugging aid. The env-server does the real serialization in JS
    (``serializeObsFrame``); this mirror exists so the Python codec can be checked
    hermetically without a live Node process. ``shaped`` appends the dense-reward tail
    (``delta_territory``/``elims_by_learner``), matching the JS emitter.
    """
    nodes = np.ascontiguousarray(frame.nodes, dtype=F32)
    players = np.ascontiguousarray(frame.players, dtype=F32)
    board = np.ascontiguousarray(frame.board, dtype=F32)
    edges = np.ascontiguousarray(frame.edges, dtype=F32)
    edge_index = np.ascontiguousarray(frame.edge_index, dtype=I32)

    _assert_shape("nodes", nodes, (frame.max_areas, NODE_W))
    _assert_shape("players", players, (frame.player_count, PLAYER_W))
    _assert_shape("board", board, (BOARD_W,))
    _assert_shape("edges", edges, (frame.num_edges, EDGE_W))
    _assert_shape("edge_index", edge_index, (frame.num_edges, 2))

    base_fields = (
        OBS_FRAME_MAGIC,
        frame.encoding_version,
        frame.max_areas,
        frame.player_count,
        frame.num_edges,
        frame.active_player_id,
        frame.turn_number,
        frame.terminal,
        frame.winner,
        frame.won,
        frame.truncated,
        float(frame.placement),
    )
    if shaped:
        header = HEADER_STRUCT_SHAPED.pack(
            *base_fields, float(frame.delta_territory), int(frame.elims_by_learner)
        )
    else:
        header = HEADER_STRUCT.pack(*base_fields)
    return b"".join(
        [
            header,
            nodes.tobytes(),
            players.tobytes(),
            board.tobytes(),
            edges.tobytes(),
            edge_index.tobytes(),
        ]
    )


def _assert_shape(name: str, arr: np.ndarray, shape: tuple[int, ...]) -> None:
    if arr.shape != shape:
        raise ValueError(f"serialize_frame: {name} shape {arr.shape} != {shape}")


# --- socket framing -----------------------------------------------------------


def recv_all(sock: _socket.socket, n: int) -> bytes:
    """Block until exactly ``n`` bytes are read; raise on a mid-read close."""
    chunks: list[bytes] = []
    got = 0
    while got < n:
        chunk = sock.recv(n - got)
        if not chunk:
            raise ConnectionError(f"socket closed after {got}/{n} bytes (env-server gone)")
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def recv_frame(
    sock: _socket.socket, max_bytes: int | None = None, *, shaped: bool = False
) -> ObsFrame:
    """Read one length-prefixed frame ``[u32 LE len][body]`` and parse it.

    ``max_bytes`` bounds the untrusted ``u32`` length prefix BEFORE the body is
    read, so a desynced/corrupt stream fails loudly here instead of buffering up to
    ~4 GiB (an OOM/hang) waiting on a body that never matches. Callers pass the
    largest legal body for their dims (``expected_frame_bytes(.., max_edges, shaped=…)``);
    ``None`` leaves it unbounded (hermetic tests with trusted input). ``shaped`` is
    forwarded to :func:`parse_frame` for the dense-reward header variant.
    """
    (length,) = _LEN_STRUCT.unpack(recv_all(sock, _LEN_STRUCT.size))
    if max_bytes is not None and length > max_bytes:
        raise ValueError(
            f"frame length {length} exceeds max {max_bytes} — stream desync or corrupt "
            f"prefix (refusing to buffer; check the wire framing / encodingVersion)."
        )
    return parse_frame(recv_all(sock, length), shaped=shaped)


def send_action(sock: _socket.socket, index: int) -> None:
    """Send one i32 LE action index (no length prefix) in reply to an obs frame."""
    sock.sendall(_ACTION_STRUCT.pack(int(index)))
