"""Cross-language parity for the observation-frame codec (``dicewars_ppo.wire``).

Hermetic — no live Node process. The golden ``obs_frame_v2.bin`` is produced by
``fixtures/gen_obs_frame_fixture.mjs`` through the real JS ``serializeObsFrame``;
here we assert the Python parser reproduces every field (byte-for-byte) and that
``serialize_frame`` round-trips back to identical bytes. If the JS frame layout
or the encoding version changes, regenerate the fixture (the version guard will
fail loudly first).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from dicewars_ppo.constants import ENCODING_VERSION, OBS_FRAME_MAGIC
from dicewars_ppo.wire import parse_frame, serialize_frame

FIXTURES = Path(__file__).parent / "fixtures"
GOLDEN_BIN = FIXTURES / "obs_frame_v2.bin"
GOLDEN_JSON = FIXTURES / "obs_frame_v2.json"


@pytest.fixture(scope="module")
def golden_bytes() -> bytes:
    if not GOLDEN_BIN.is_file():
        pytest.skip(f"missing {GOLDEN_BIN} — run `node {FIXTURES / 'gen_obs_frame_fixture.mjs'}`")
    return GOLDEN_BIN.read_bytes()


@pytest.fixture(scope="module")
def golden_json() -> dict:
    return json.loads(GOLDEN_JSON.read_text())


def test_parse_matches_golden_json(golden_bytes: bytes, golden_json: dict) -> None:
    frame = parse_frame(golden_bytes)

    assert frame.encoding_version == golden_json["encodingVersion"] == ENCODING_VERSION
    assert frame.max_areas == golden_json["maxAreas"]
    assert frame.player_count == golden_json["playerCount"]
    assert frame.num_edges == golden_json["numEdges"]
    assert frame.active_player_id == golden_json["activePlayerId"]
    assert frame.turn_number == golden_json["turnNumber"]
    assert frame.terminal == golden_json["terminal"]
    assert frame.winner == golden_json["winner"]
    assert frame.won == golden_json["won"]
    assert frame.placement == pytest.approx(golden_json["placement"])

    np.testing.assert_array_equal(frame.nodes, np.array(golden_json["nodes"], dtype=np.float32))
    np.testing.assert_array_equal(frame.players, np.array(golden_json["players"], dtype=np.float32))
    np.testing.assert_array_equal(frame.board, np.array(golden_json["board"], dtype=np.float32))
    np.testing.assert_array_equal(frame.edges, np.array(golden_json["edges"], dtype=np.float32))
    np.testing.assert_array_equal(
        frame.edge_index, np.array(golden_json["edgeIndex"], dtype=np.int32)
    )

    # Tensor shapes/dtypes match the v2 contract.
    assert frame.nodes.shape == (frame.max_areas, 8) and frame.nodes.dtype == np.float32
    assert frame.players.shape == (frame.player_count, 6)
    assert frame.board.shape == (5,)
    assert frame.edges.shape == (frame.num_edges, 7)
    assert frame.edge_index.shape == (frame.num_edges, 2) and frame.edge_index.dtype == np.int32

    # STOP is the last edge row (isStop == col 3 == 1).
    assert frame.edges[-1, 3] == 1.0


def test_round_trip_is_byte_identical(golden_bytes: bytes) -> None:
    assert serialize_frame(parse_frame(golden_bytes)) == golden_bytes


def test_bad_magic_raises() -> None:
    body = bytearray(GOLDEN_BIN.read_bytes())
    body[0] ^= 0xFF  # corrupt the magic
    with pytest.raises(ValueError, match="bad magic"):
        parse_frame(bytes(body))


def test_version_mismatch_raises() -> None:
    import struct

    good = bytearray(GOLDEN_BIN.read_bytes())
    struct.pack_into("<i", good, 4, ENCODING_VERSION + 99)  # header field [1] = encodingVersion
    with pytest.raises(ValueError, match="encodingVersion"):
        parse_frame(bytes(good))


def test_truncated_frame_raises() -> None:
    good = GOLDEN_BIN.read_bytes()
    with pytest.raises(ValueError, match="bytes"):
        parse_frame(good[:-8])  # drop the last edge_index int → length mismatch


def test_magic_constant_is_dwob() -> None:
    # "DWOB" big-endian bytes → little-endian i32 the encoder writes.
    assert OBS_FRAME_MAGIC == int.from_bytes(b"DWOB", "big") == 0x44574F42
