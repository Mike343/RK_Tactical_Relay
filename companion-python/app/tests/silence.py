"""An idle relay still accepts outgoing positions but stops delivering contacts."""
import asyncio
import json
from exercise import Client, SimFixture, frame, serve


async def run():
    sim=SimFixture()
    sim.fail_first_track=False
    counts=[]
    done=asyncio.Event()
    async def handler(ws):
        hello=json.loads(await ws.recv())
        assert hello['protocol']==3
        counts.append(0)
        which=len(counts)-1
        await ws.send('{"type":"welcome"}')
        await ws.send(frame(which))
        try:
            async for msg in ws:
                if json.loads(msg)['type']=='state':
                    counts[which]+=1
                    if which==1 and counts[which]>=2: done.set()
        except Exception:
            if which!=0: raise
    async with serve(handler,"127.0.0.1",0) as srv:
        uri="ws://127.0.0.1:"+str(srv.sockets[0].getsockname()[1])
        c=Client(sim,dict(relay_url=uri,player_id="x",display_name="Rick"))
        await asyncio.wait_for(c.run(done.is_set),20)
    assert len(counts)==2 and counts[0]>45 and len(sim.frames)==2
    assert c.received==2 and len(sim.heartbeats)>=13
    print("PASS: silent socket still sent positions; heartbeat continued; no stale pilot replays; rejoined and delivered the next position.")
asyncio.run(run())
