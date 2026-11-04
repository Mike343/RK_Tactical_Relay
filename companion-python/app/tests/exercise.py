"""Exercise the production WebSocket client and contact publisher against a local relay."""
import asyncio
import json
import logging
from pathlib import Path
import struct
import sys
import time
from collections import deque

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/"vendor"),str(ROOT)]
from websockets.asyncio.server import serve
from client import Client
from sim import HEART, IN, OUT, TLM, TRACK
from protocol import AIRCRAFT, COMBAT, CONTACT, HEADER, TRACK_MAGIC, TRACK_SIZE, TELEMETRY, panel_snapshot


def packet(kind, req, data):
    return kind, struct.pack("<10I",40+len(data),0,kind,req,0,req,0,0,0,1)+data


def frame(i):
    # The first two frames deliberately have the SAME seq but changed positions.
    seq = 529146 if i < 2 else 529146+i
    data = bytearray(TRACK_SIZE)
    HEADER.pack_into(data,0,TRACK_MAGIC,4,TRACK_SIZE,seq,2,0)
    for slot in range(2):
        CONTACT.pack_into(data,24+120*slot,10+slot,1+slot,35.68+i*.00032,
                          -117.70+slot*.02,8000.,0.,275.,(b"RED",b"BLUE")[slot],b"F/A-18")
    return bytes(data)


class SimFixture:
    def __init__(self):
        self.sent = {}
        self.queue = deque()
        self.frames = []
        self.heartbeats = []
        self.events = []
        self.fail_first_track = True
        self.queue.extend([packet(8,1,AIRCRAFT.pack(35.7,-117.6,8000,0,275,b"F/A-18")),
                           packet(16,TLM,TELEMETRY.pack(0x31544b52,2,168,1,0,0,0,0,1,29,*([0]*32)))])
    def watch(self,req): pass
    def packets(self):
        while self.queue: yield self.queue.popleft()
    def write(self,area,data,token=None):
        if area == TRACK:
            if data == frame(0) and self.fail_first_track:
                self.fail_first_track = False
                raise OSError("injected failure")
            if HEADER.unpack_from(data)[4]: self.frames.append(data)
            self.queue.append(packet(16,TRACK,data))
        if area == HEART: self.heartbeats.append(data)
        if area == IN: self.events.append(data)


async def test():
    event = COMBAT.pack(0x31434b52,3,80,1,1,1,0,10,99,0,35,-117,8000,0,1,1,0)
    sim = SimFixture()
    complete = asyncio.Event()
    flight = asyncio.get_running_loop().create_future()
    seen_states = []
    combat_sent = []
    async def handler(ws):
        try:
            hello = json.loads(await ws.recv())
            assert hello == dict(type="hello",protocol=3,id="demo-id",name="Observer")
            await ws.send(json.dumps(dict(type="welcome",id="demo-id")))
            async def collect():
                async for message in ws:
                    j=json.loads(message)
                    if j["type"] == "state": seen_states.append(j)
                    if j["type"] == "combat": combat_sent.append(j)
            reader=asyncio.create_task(collect())
            try:
                for i in range(120):
                    raw=frame(i)
                    # Fragment the WebSocket message at a non-record boundary.
                    await ws.send([raw[:31],raw[31:]])
                    if i==0:
                        await asyncio.sleep(.35)  # Same frame must retry after failure.
                    if i==2:
                        sim.queue.append(packet(16,OUT,event))
                        await ws.send(json.dumps(dict(type="combat",event=1,weapon=1,source=15,target=10,
                            weaponId=99,flags=0,lat=35,lon=-117,altFt=8000,heading=0,damage=1,duration=1,missDistance=0)))
                    await asyncio.sleep(.25)
                complete.set()
                await ws.wait_closed()
            finally:
                reader.cancel()
                await asyncio.gather(reader,return_exceptions=True)
            flight.set_result(None)
        except Exception as e:
            if not flight.done(): flight.set_exception(e)
            complete.set()

    async with serve(handler,"127.0.0.1",0) as server:
        cfg=dict(player_id="demo-id",display_name="Observer",
                 relay_url=f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}")
        c=Client(sim,cfg)
        await asyncio.wait_for(c.run(complete.is_set),40)
        await asyncio.wait_for(flight,3)
    assert c.received == 120 and len(sim.frames)==120 and sim.frames == [frame(i) for i in range(120)]
    assert c.read_back >= 120 and not sim.fail_first_track and len(sim.heartbeats)>=30
    assert len(seen_states)>120 and all(s['team']==1 and s['flight']==29 for s in seen_states)
    assert len(sim.events)==1 and len(combat_sent)==1 and combat_sent[0]['target']==10
    print(f"PASS: {len(sim.frames)} moving two-pilot snapshots, both colors, {len(seen_states)} outgoing positions, "
          f"{c.read_back} track readbacks (including initial empty frame). Both combat directions passed.")


if __name__=="__main__":
    orig=bytearray(frame(1))
    struct.pack_into("<I",orig,4,3)
    struct.pack_into("<I",orig,28,0)
    converted=panel_snapshot(orig)
    assert converted[:4]==orig[:4] and converted[8:]==orig[8:] and converted[4:8]==b'\4\0\0\0'
    try: panel_snapshot(orig[:-1])
    except ValueError: pass
    else: raise AssertionError("incomplete frame accepted")
    logging.basicConfig(level=logging.WARNING)
    asyncio.run(test())
