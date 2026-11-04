"""RK relay and panel payloads from the editable companion Protocol.h."""
import math
import struct

TRACK_MAGIC = 0x31504d52
TRACK_SIZE = 3864
TELEMETRY = struct.Struct("<42I")
STATUS = struct.Struct("<6I")
COMBAT = struct.Struct("<10I3d4f")
AIRCRAFT = struct.Struct("<5d256s")
HEADER = struct.Struct("<6I")
CONTACT = struct.Struct("<II3d2f32s48s")
EVENT_KEYS = ("event", "weapon", "source", "target", "weaponId", "flags",
              "lat", "lon", "altFt", "heading", "damage", "duration", "missDistance")


def panel_snapshot(raw):
    if len(raw) != TRACK_SIZE:
        raise ValueError(f"snapshot size {len(raw)}, expected {TRACK_SIZE}")
    magic, version, size, seq, count, reserved = HEADER.unpack_from(raw)
    if magic != TRACK_MAGIC or version not in (3, 4) or size != TRACK_SIZE or count > 32:
        raise ValueError(f"invalid snapshot header: {magic:x}, {version}, {size}, {count}")
    result = bytearray(TRACK_SIZE)
    valid = 0
    for i in range(count):
        start = HEADER.size + i * CONTACT.size
        peer, flags, lat, lon, alt, heading, speed, _, _ = CONTACT.unpack_from(raw, start)
        if not (peer and abs(lat) <= 90 and abs(lon) <= 180 and
                all(map(math.isfinite, (alt, heading, speed)))):
            continue
        dest = HEADER.size + valid * CONTACT.size
        result[dest:dest + CONTACT.size] = raw[start:start + CONTACT.size]
        valid += 1
    HEADER.pack_into(result, 0, magic, 4, size, seq, valid, reserved)
    return bytes(result)


def empty(seq=1):
    return HEADER.pack(TRACK_MAGIC, 4, TRACK_SIZE, seq, 0, 0) + bytes(TRACK_SIZE - HEADER.size)


def combat_to_json(data):
    if len(data) < COMBAT.size:
        return None
    magic, ver, size, seq, *fields = COMBAT.unpack_from(data)
    if (magic, ver, size) != (0x31434b52, 3, COMBAT.size) or not 1 <= fields[0] <= 9:
        return None
    message = dict(zip(EVENT_KEYS, fields))
    del message["source"]  # Relay assigns the sender from the connection.
    return dict(type="combat", **message)


def combat_to_panel(message, seq):
    values = [message[k] for k in EVENT_KEYS]
    return COMBAT.pack(0x31434b52,3,COMBAT.size,seq,*values)
