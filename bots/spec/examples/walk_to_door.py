#!/usr/bin/env python3
"""Walk toward the enemy door: a whole fill/balance brain in Python.

Standard library only. Point `bots.brain` at it in config.json:

    "brain": ["python3", "bots/spec/examples/walk_to_door.py"]

The host talks bot protocol 5 on stdin/stdout (spec: bots/spec/README.md).
Every frame is a little-endian u32 length, then that many bytes: "BP", wire
version 1, a kind byte, a u32 request id, and the body. Strings are a u16
byte length plus UTF-8. This brain reads only what it needs: each team's
door edge from the map, and each body's id, team, and position from a think
batch. Every requested pawn holds W and faces the enemy door's midpoint.
"""
import math
import struct
import sys

PROTOCOL_VERSION = 5

HELLO, LOAD_MAP, SYNCHRONIZE, THINK, SHUTDOWN = 17, 18, 19, 20, 21
R_HELLO, R_ACK, R_THINK, R_ERROR = 81, 82, 83, 84
EDGES = ["south", "east", "north", "west"]


class Reader:
    def __init__(self, body):
        self.body, self.at = body, 0

    def take(self, fmt):
        values = struct.unpack_from("<" + fmt, self.body, self.at)
        self.at += struct.calcsize("<" + fmt)
        return values if len(values) > 1 else values[0]

    def string(self):
        n = self.take("H")
        text = self.body[self.at:self.at + n].decode("utf-8")
        self.at += n
        return text


class Writer:
    def __init__(self):
        self.parts = []

    def put(self, fmt, *values):
        self.parts.append(struct.pack("<" + fmt, *values))

    def string(self, text):
        data = text.encode("utf-8")
        self.put("H", len(data))
        self.parts.append(data)

    def frame(self, kind, request_id):
        payload = b"BP" + bytes([1, kind]) + struct.pack("<I", request_id)
        payload += b"".join(self.parts)
        return struct.pack("<I", len(payload)) + payload


def read_exact(n):
    data = b""
    while len(data) < n:
        chunk = sys.stdin.buffer.read(n - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def send(data):
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def ack(request_id):
    w = Writer()
    w.put("?", True)
    send(w.frame(R_ACK, request_id))


def door_midpoints(r):
    """Map header up to both sides. The rest of the map is not needed."""
    r.string()  # id
    r.string()  # revision
    r.take("H")  # format version
    min_x, max_x, min_z, max_z = r.take("dddd")
    corners = [(min_x, min_z), (max_x, min_z), (max_x, max_z), (min_x, max_z)]
    doors = {}
    for team in ("A", "B"):
        edge = r.take("B")
        r.take("dd")  # door half width, spawn radius
        (ax, az), (bx, bz) = corners[edge], corners[(edge + 1) % 4]
        doors[team] = ((ax + bx) / 2, (az + bz) / 2)
    return doors


def read_player(r):
    pid = r.string()
    r.take("B")  # kind: 0 human, 1 bot, 2 agent
    team = "A" if r.take("B") == 0 else "B"
    flags, flags2 = r.take("BB")
    r.take("diI")  # health, score, spawned-at tick
    x, _y, z = r.take("ddd")
    r.take("ddddd")  # velocity xyz, yaw, pitch
    if flags & 8:
        r.take("d")  # sprint stamina
    if flags & 16 and not flags2 & 2:
        r.take("d")  # move yaw
    if flags & 128:
        for _ in range(r.take("H")):
            r.take("Hii")  # carried weapon: id, magazine, spare clips
    if flags2 & 1:
        r.take("B")  # glitch state
    r.take("Hii?d")  # active weapon: id, magazine, spare, reloading, last shot
    for _ in range(r.take("H")):
        r.string()
        r.take("?diB")  # skill: equipped, charge, active until, can activate
    return pid, team, x, z


def think(r, request_id, doors):
    tick = r.take("I")
    r.take("d")  # sim delta
    revision = r.string()
    r.take("?iii")  # doors open, door change tick, team scores
    bodies = {}
    for _ in range(r.take("I")):
        pid, team, x, z = read_player(r)
        bodies[pid] = (team, x, z)
    r.take("?")  # match over
    apply_tick = r.take("I")
    pawns = [(r.string(), r.take("I")) for _ in range(r.take("I"))]

    w = Writer()
    w.put("II", tick, apply_tick)
    w.string(revision)
    w.put("I", len(pawns))
    for pawn_id, spawned_at in pawns:
        w.string(pawn_id)
        w.put("I", spawned_at)
        body = bodies.get(pawn_id)
        if body is None or doors is None:
            w.put("B", 0)  # null action: hold the previous keys
            continue
        team, x, z = body
        tx, tz = doors["B" if team == "A" else "A"]
        yaw = math.atan2(-(tx - x), -(tz - z))  # forward is (-sin yaw, -cos yaw)
        w.put("B", 1 | 2)  # action present, with input
        w.put("B", 1)  # keys: forward only
        w.put("dd", yaw, 0.0)  # yaw, pitch
        w.put("B", 0)  # no look samples: the host eases to the new yaw
    send(w.frame(R_THINK, request_id))


def main():
    doors = None
    while True:
        prefix = read_exact(4)
        if prefix is None:
            return
        payload = read_exact(struct.unpack("<I", prefix)[0])
        if payload is None or payload[:3] != b"BP\x01":
            return
        kind = payload[3]
        request_id = struct.unpack_from("<I", payload, 4)[0]
        r = Reader(payload[8:])
        if kind == HELLO:
            version = r.take("H")
            w = Writer()
            if version != PROTOCOL_VERSION:
                w.string("protocol-version")
                w.string(f"brain speaks {PROTOCOL_VERSION}, host sent {version}")
                w.put("?", False)
                send(w.frame(R_ERROR, request_id))
                return
            w.put("H", PROTOCOL_VERSION)
            w.string("walk-to-door.py")
            send(w.frame(R_HELLO, request_id))
        elif kind == LOAD_MAP:
            doors = door_midpoints(r)
            ack(request_id)
        elif kind == SYNCHRONIZE:
            ack(request_id)  # the think batch names the pawns; nothing to keep
        elif kind == THINK:
            think(r, request_id, doors)
        elif kind == SHUTDOWN:
            ack(request_id)
            return
        else:
            w = Writer()
            w.string("unsupported")
            w.string(f"request kind {kind}")
            w.put("?", True)
            send(w.frame(R_ERROR, request_id))


if __name__ == "__main__":
    main()
