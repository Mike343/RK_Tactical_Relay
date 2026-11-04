import asyncio
from collections import deque
import json
import logging
import math
import struct
import time

from websockets.asyncio.client import connect
from protocol import (AIRCRAFT, COMBAT, HEADER, STATUS, TELEMETRY, combat_to_json,
                      combat_to_panel, empty, panel_snapshot)
from sim import TRACK, HEART, TLM, OUT, IN

log = logging.getLogger("RK")


class Client:
    def __init__(self, sim, config, audio=None):
        self.sim, self.config, self.audio = sim, config, audio
        self.aircraft = None
        self.team, self.flight, self.detected = 0, 0, [0]*32
        self.outgoing = deque(maxlen=256)
        self.incoming = deque(maxlen=256)
        self.relay_up = False
        self.heartbeat_seq = self.event_seq = self.generation = 0
        self.received = self.submitted = self.read_back = 0
        self.sim_readback_at = self.received_at = 0
        self.last_attempt = self.sent_generation = 0
        self.pending = None
        self.last_count = None
        self.last_team = None
        self.last_telemetry = 0

    def offer(self, raw):
        self.generation += 1
        self.pending = raw
        self.last_attempt = 0

    def receive_tracks(self, message):
        raw = panel_snapshot(message)
        self.received_at = time.monotonic()
        self.received += 1
        self.offer(raw)
        _, _, _, seq, count, _ = HEADER.unpack_from(raw)
        if count != self.last_count:
            log.info("Relay sent %d contacts (seq %d)",count,seq)
            self.last_count = count

    def publish(self, now):
        if self.pending is None or now-self.last_attempt < 0.25:
            return
        # Don't refresh expired real positions after repeated write failures.
        if self.received_at and now-self.received_at >= 10 and HEADER.unpack_from(self.pending)[4]:
            self.offer(empty())
        self.last_attempt = now
        try:
            self.sim.write(TRACK,self.pending,self.generation)
        except OSError as e:
            log.warning("%s; will retry latest positions",e)
            return
        self.sent_generation = self.generation
        self.submitted += 1

    def packet(self, kind, raw):
        if kind == 3: raise ConnectionError("MSFS closed")
        if kind == 1 and len(raw)>=24:
            code, packet, index = struct.unpack_from("<III",raw,12)
            op, token = self.sim.sent.get(packet,("unknown",None))
            if code == 32 and op.startswith("create "): return
            log.warning("SimConnect exception %d in %s (send %d, index %d)",code,op,packet,index)
            if token == self.generation: self.last_attempt = 0
            return
        if kind not in (8,16) or len(raw)<40: return
        req, = struct.unpack_from("<I",raw,12)
        data = raw[40:]
        if kind == 8 and req == 1 and len(data)>=AIRCRAFT.size:
            lat, lon, alt, heading, speed, title = AIRCRAFT.unpack_from(data)
            if abs(lat)<=90 and abs(lon)<=180 and all(map(math.isfinite,(alt,heading,speed))):
                self.aircraft = dict(lat=lat,lon=lon,altFt=alt,heading=heading,speedKts=speed,
                                     aircraft=title.split(b'\0')[0].decode("utf8","replace"))
        elif kind == 16 and req == TLM and len(data)>=TELEMETRY.size:
            words = TELEMETRY.unpack_from(data)
            if words[:3] == (0x31544b52,2,TELEMETRY.size):
                self.team, self.flight, self.detected = words[8],words[9],list(words[10:])
                self.last_telemetry = time.monotonic()
                if self.team != self.last_team:
                    log.info("Local team %d, flight %d",self.team,self.flight)
                    self.last_team = self.team
                if self.audio: self.audio.telemetry(words)
        elif kind == 16 and req == TRACK and len(data)>=3864:
            self.read_back += 1
            self.sim_readback_at = time.monotonic()
            if self.sent_generation == self.generation and self.pending == data[:3864]:
                self.pending = None
        elif kind == 16 and req == OUT and self.relay_up:
            msg = combat_to_json(data)
            if msg: self.outgoing.append(msg)

    async def send(self, ws):
        started = time.monotonic()
        while True:
            if self.aircraft:
                await ws.send(json.dumps(dict(type="state", **self.aircraft,
                            team=self.team,flight=self.flight,detected=self.detected),allow_nan=False))
                # A relay may withhold updates before the first aircraft state.
                if time.monotonic()-max(started,self.received_at)>12:
                    raise ConnectionError("no valid contact frames for 12 seconds while sending positions")
            else:
                started = time.monotonic()
            while self.outgoing:
                await ws.send(json.dumps(self.outgoing[0],allow_nan=False))
                self.outgoing.popleft()
            await asyncio.sleep(.2)

    async def receive(self, ws):
        async for message in ws:
            if isinstance(message,bytes):
                try: self.receive_tracks(message)
                except ValueError as e: log.warning("Relay frame rejected: %s",e)
                continue
            msg = json.loads(message)
            if msg.get("type") == "error": raise ConnectionError(str(msg.get("message","relay error")))
            if msg.get("type") == "combat":
                try:
                    self.event_seq = self.event_seq % 0xffffffff + 1
                    self.incoming.append(combat_to_panel(msg,self.event_seq))
                except (KeyError, ValueError, TypeError, struct.error) as e:
                    log.warning("Invalid combat message: %s",e)
        raise ConnectionError("relay closed")

    async def relay(self):
        while True:
            try:
                async with connect(self.config["relay_url"],open_timeout=6,close_timeout=2,
                                   ping_interval=15,ping_timeout=15,max_size=65536,proxy=None) as ws:
                    await ws.send(json.dumps(dict(type="hello",protocol=3,id=self.config["player_id"],
                                                  name=self.config["display_name"])))
                    # A relay may send a binary snapshot before its welcome.
                    async def welcome():
                        async for message in ws:
                            if isinstance(message,bytes):
                                self.receive_tracks(message)
                                continue
                            reply=json.loads(message)
                            if reply.get("type")=="welcome": return reply
                            if reply.get("type")=="error": raise ConnectionError(reply.get("message","rejected"))
                        raise ConnectionError("closed during hello")
                    reply = await asyncio.wait_for(welcome(),8)
                    self.relay_up = True
                    log.info("Relay welcomed %s",reply.get("name",self.config["display_name"]))
                    tasks = [asyncio.create_task(self.send(ws)),asyncio.create_task(self.receive(ws))]
                    try:
                        done,_ = await asyncio.wait(tasks,return_when=asyncio.FIRST_COMPLETED)
                        for task in done: task.result()
                    finally:
                        for task in tasks: task.cancel()
                        await asyncio.gather(*tasks,return_exceptions=True)
            except (OSError, ValueError, TimeoutError, RuntimeError, ConnectionError) as e:
                log.warning("Relay: %s",e)
            except Exception as e:
                # websockets handshake and close errors also reconnect.
                log.warning("Relay %s: %s",type(e).__name__,e)
            finally:
                self.relay_up = False
                self.outgoing.clear()
                self.incoming.clear()
                self.offer(empty())
            await asyncio.sleep(2)

    def heartbeat(self, running=True):
        self.heartbeat_seq = self.heartbeat_seq % 0xffffffff + 1
        self.sim.write(HEART,STATUS.pack(0x31534b52,1,STATUS.size,self.heartbeat_seq,running,self.relay_up and running))

    async def run(self, stop):
        self.offer(empty())
        relay_task = asyncio.create_task(self.relay())
        last_beat = last_note = last_sub = 0
        try:
            while not stop():
                now = time.monotonic()
                for kind,raw in self.sim.packets(): self.packet(kind,raw)
                self.publish(now)
                if self.incoming:
                    self.sim.write(IN,self.incoming[0])
                    self.incoming.popleft()
                if now-last_beat>=1:
                    self.heartbeat()
                    last_beat=now
                    if self.audio and now-self.last_telemetry>1: self.audio.idle()
                if not self.last_telemetry and now-last_sub>2:
                    self.sim.watch(TLM)
                    last_sub=now
                if now-last_note>=5:
                    log.info("Contacts: relay frames %d | SimConnect writes %d | SimConnect readbacks %d | last relay update %s",
                             self.received,self.submitted,self.read_back,
                             ("%.1fs ago"%(now-self.received_at)) if self.received_at else "none")
                    last_note=now
                await asyncio.sleep(.01)
        finally:
            relay_task.cancel()
            await asyncio.gather(relay_task,return_exceptions=True)
            try:
                self.sim.write(TRACK,empty())
                self.heartbeat(False)
            except OSError: pass
            if self.audio: self.audio.reset()
