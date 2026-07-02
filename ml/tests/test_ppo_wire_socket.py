"""Socket-framing layer of ``dicewars_ppo.wire`` — hermetic via ``socketpair()``.

No live Node server: a connected pair of in-process sockets exercises the
length-prefixed frame transport (``recv_all`` / ``recv_frame`` / ``send_action``)
and the desync guards, complementing the body-codec parity in ``test_ppo_wire``.
These are the contracts a real PPO step depends on and the ones that won't surface
on a single-segment localhost frame, so they're worth locking in CI (numpy-only).
"""

from __future__ import annotations

import socket
import struct
from pathlib import Path

import pytest

from dicewars_ppo.wire import recv_all, recv_frame, send_action, serialize_frame

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN_BIN = FIXTURES / "obs_frame_v3.bin"


@pytest.fixture
def sockpair():
    a, b = socket.socketpair()
    try:
        yield a, b
    finally:
        a.close()
        b.close()


def test_recv_all_reassembles_multiple_chunks(sockpair):
    # Two separate writes must be concatenated, not short-read — the reassembly path
    # a single-TCP-segment localhost frame never exercises.
    a, b = sockpair
    a.sendall(b"\x01\x02\x03")
    a.sendall(b"\x04\x05\x06\x07\x08")
    assert recv_all(b, 8) == bytes(range(1, 9))


def test_recv_all_raises_on_midread_close(sockpair):
    # The dead-server detector: peer closes before the requested bytes arrive.
    a, b = sockpair
    a.sendall(b"\x00" * 10)
    a.close()
    with pytest.raises(ConnectionError, match="closed after 10/20"):
        recv_all(b, 20)


def test_send_action_is_bare_i32_le(sockpair):
    a, b = sockpair
    send_action(a, 5)
    assert recv_all(b, 4) == struct.pack("<i", 5)  # exactly 4 bytes, no length prefix


def test_send_action_round_trips_negative(sockpair):
    a, b = sockpair
    send_action(a, -1)
    (val,) = struct.unpack("<i", recv_all(b, 4))
    assert val == -1  # signed i32


def test_recv_frame_round_trips_golden(sockpair):
    # serialize → prefix → recv → parse closes the framing loop the body-only golden
    # test cannot, locking the `[u32 LE len]` inbound prefix contract.
    a, b = sockpair
    body = GOLDEN_BIN.read_bytes()
    a.sendall(struct.pack("<I", len(body)) + body)
    frame = recv_frame(b)
    assert serialize_frame(frame) == body


def test_recv_frame_rejects_oversized_prefix(sockpair):
    # A corrupt/huge length prefix must fail loud BEFORE buffering the body.
    a, b = sockpair
    a.sendall(struct.pack("<I", 10_000_000))
    with pytest.raises(ValueError, match="exceeds max"):
        recv_frame(b, max_bytes=1024)
