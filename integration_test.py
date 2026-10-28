"""Protocol 3 local wire tests; runs against compiled Linux relay. Requires pip install websocket-client."""
import base64
import json
import os
import socket
import struct
import subprocess
import time
import urllib.request
import websocket

PORT=18787
ROOT=os.path.dirname(os.path.abspath(__file__))

def read_until(ws, wanted, timeout=6):
    till=time.time()+timeout
    while time.time()<till:
        frame=ws.recv_frame()
        if frame is None:continue
        if frame.opcode==websocket.ABNF.OPCODE_PING:
            ws.pong(frame.data); continue
        if frame.opcode==websocket.ABNF.OPCODE_BINARY:
            if wanted=='binary': return frame.data
        if frame.opcode==websocket.ABNF.OPCODE_TEXT:
            o=json.loads(frame.data)
            if wanted==o['type']:return o
    raise AssertionError('Missing '+wanted)

def main():
    print('Building Linux test executable ...')
    subprocess.run(['go','build','-trimpath','-o','rk_relay_integration','.'],cwd=ROOT,check=True)
    env=os.environ.copy();env['PORT']=str(PORT)
    proc=subprocess.Popen([os.path.join(ROOT,'rk_relay_integration')],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
    try:
        for _ in range(60):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health',timeout=.4) as resp: obj=json.load(resp)
                break
            except Exception:time.sleep(.15)
        else: raise AssertionError('Relay did not start')
        assert obj['protocol']==3 and obj['players']==0
        # An unauthenticated remote dashboard must never be exposed.
        stats=json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/stats'))
        assert stats['players']==0
        a=websocket.create_connection(f'ws://127.0.0.1:{PORT}/',timeout=5)
        a.send(json.dumps({'type':'hello','protocol':3,'id':'alpha','name':'Alpha'}))
        wel=read_until(a,'welcome'); assert wel['network']=='rk-tactical-global'
        snap=read_until(a,'binary');assert len(snap)==3864
        assert struct.unpack_from('<IIIII',snap,0)[:3]==(0x31504d52,3,3864)
        a.send(json.dumps(dict(type='state',lat=42.0,lon=-121.0,altFt=4500,heading=30,speedKts=220,aircraft='F-18')))
        b=websocket.create_connection(f'ws://127.0.0.1:{PORT}/',timeout=5)
        b.send(json.dumps({'type':'hello','protocol':3,'id':'bravo','name':'Bravo'}))
        assert read_until(b,'welcome')['protocol']==3
        snap=read_until(b,'binary');count=struct.unpack_from('<I',snap,16)[0]
        assert count==1, ('expected alpha only',count)
        idhash=2166136261
        for x in b'alpha':idhash=((idhash^x)*16777619)&0xffffffff
        assert struct.unpack_from('<I',snap,24)[0]==idhash
        assert struct.unpack_from('<ddd',snap,32)==(42.0,-121.0,4500.0)
        assert snap[64:69]==b'Alpha'
        # One combat event; non-hit events fan out while hit only goes to target.
        target=(0x60000000 | (hash_id('bravo') & 0x0fffffff))
        combat=dict(type='combat',event=1,weapon=2,target=target,weaponId=99,flags=0,lat=42.0,lon=-121.0,altFt=4500,heading=45,damage=25,duration=4,missDistance=10)
        a.send(json.dumps(combat))
        received=read_until(b,'combat');assert received['source']==(0x60000000 | (idhash & 0xfffffff))
        assert received['flags']&1 and received['weaponId']==99
        combat['event']=3;a.send(json.dumps(combat))
        hit=read_until(b,'combat');assert hit['event']==3
        dash=json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/api/stats'))
        assert dash['players']==2 and dash['counters']['Combat']>=2
        html=urllib.request.urlopen(f'http://127.0.0.1:{PORT}/dashboard').read().decode()
        assert 'light' in html and 'CONNECTED PILOTS' in html
        # Unknown client protocol does not enter the population.
        x=websocket.create_connection(f'ws://127.0.0.1:{PORT}/',timeout=5)
        x.send(json.dumps({'type':'hello','protocol':1,'id':'old','name':'Old'}))
        assert read_until(x,'error')['message']=='unsupported protocol'
        x.close()
        a.close();b.close()
        print('PASS: health, hello, binary snapshot, state, combat, targeted hit, dashboard, protocol rejection')
    finally:
        proc.terminate()
        try:outs=proc.communicate(timeout=3)[0]
        except subprocess.TimeoutExpired:proc.kill();outs=proc.communicate()[0]
        print('SERVER LOG LAST LINES:')
        print('\n'.join(outs.decode(errors='replace').splitlines()[-12:]))

def hash_id(name):
    h=2166136261
    for x in name.encode():h=((h^x)*16777619)&0xffffffff
    return h or 1

if __name__=='__main__':main()
