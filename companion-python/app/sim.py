"""Single-threaded, 64-bit SimConnect interface. All payloads cross as packed bytes."""
import ctypes as C
import struct

from protocol import TRACK_SIZE, TELEMETRY, STATUS, COMBAT

UINT = C.c_uint32
HANDLE = C.c_void_p
PTR = C.POINTER
# IDs are local to this SimConnect connection.
TRACK, HEART, TLM, OUT, IN = 10, 11, 12, 13, 14
AREAS = ((TRACK,b"RK_TACTICAL_MULTIPLAYER_CONTACTS_V4",TRACK_SIZE),
         (HEART,b"RK_TACTICAL_COMPANION_STATUS_V1",STATUS.size),
         (TLM,b"RK_TACTICAL_AUDIO_TELEMETRY_V2",TELEMETRY.size),
         (OUT,b"RK_TACTICAL_MULTIPLAYER_COMBAT_OUT_V3",COMBAT.size),
         (IN,b"RK_TACTICAL_MULTIPLAYER_COMBAT_IN_V3",COMBAT.size))


class Sim:
    def __init__(self, dll):
        self.dll = dll
        self.h = HANDLE()
        self.sent = {}
        signatures = {
            "Open": [PTR(HANDLE),C.c_char_p,HANDLE,UINT,HANDLE,UINT],
            "Close": [HANDLE],
            "GetNextDispatch": [HANDLE,PTR(HANDLE),PTR(UINT)],
            "GetLastSentPacketID": [HANDLE,PTR(UINT)],
            "AddToDataDefinition": [HANDLE,UINT,C.c_char_p,C.c_char_p,UINT,C.c_float,UINT],
            "RequestDataOnSimObject": [HANDLE]+[UINT]*8,
            "MapClientDataNameToID": [HANDLE,C.c_char_p,UINT],
            "CreateClientData": [HANDLE,UINT,UINT,UINT],
            "AddToClientDataDefinition": [HANDLE,UINT,UINT,UINT,C.c_float,UINT],
            "RequestClientData": [HANDLE]+[UINT]*8,
            "SetClientData": [HANDLE]+[UINT]*5+[C.c_void_p]}
        for name, args in signatures.items():
            func = getattr(dll, "SimConnect_"+name)
            func.argtypes, func.restype = args, C.c_int32
            setattr(self, name, func)

    def setup(self):
        self.call("Open", self.Open(C.byref(self.h), b"RK Open Companion",None,0,None,0))
        for area, name, size in AREAS:
            self.call("map "+name.decode(), self.MapClientDataNameToID(self.h,name,area))
            # Both the WASM and companion may create shared areas. A duplicate-area
            # notification is harmless and doesn't cancel the definition.
            self.call("create "+name.decode(), self.CreateClientData(self.h,area,size,0), optional=True)
            self.call("define "+name.decode(), self.AddToClientDataDefinition(self.h,area,0,size,0,0xffffffff))
            if area in (TLM,OUT,TRACK):
                self.watch(area)
        for name, units in [(b"PLANE LATITUDE",b"degrees"),(b"PLANE LONGITUDE",b"degrees"),
                            (b"PLANE ALTITUDE",b"feet"),(b"PLANE HEADING DEGREES TRUE",b"degrees"),
                            (b"GROUND VELOCITY",b"knots"),(b"TITLE",None)]:
            self.call("aircraft "+name.decode(), self.AddToDataDefinition(self.h,1,name,units,9 if units is None else 4,0,0xffffffff))
        self.call("request aircraft",self.RequestDataOnSimObject(self.h,1,1,0,3,0,0,5,0))

    def watch(self, area):
        self.call("watch "+str(area),self.RequestClientData(self.h,area,area,area,3,0,0,0,0))

    def call(self, op, hr, token=None, optional=False):
        if hr < 0:
            if optional: return
            raise OSError(f"{op}: HRESULT 0x{hr & 0xffffffff:08x}")
        packet = UINT()
        if self.GetLastSentPacketID(self.h,C.byref(packet)) >= 0:
            self.sent[packet.value] = (op,token)
            if len(self.sent) > 1024:
                self.sent.pop(next(iter(self.sent)))

    def write(self, area, data, token=None):
        self.call("write "+str(area),self.SetClientData(self.h,area,area,0,0,len(data),data),token)

    def packets(self):
        for _ in range(128):
            ptr, size = HANDLE(), UINT()
            hr = self.GetNextDispatch(self.h,C.byref(ptr),C.byref(size))
            if hr < 0 or not ptr or size.value < 12: break
            if size.value > 1048576: raise OSError("oversized SimConnect dispatch")
            raw = C.string_at(ptr,size.value)
            declared, _, kind = struct.unpack_from("<III",raw)
            if kind == 0: break
            if 12 <= declared <= len(raw): yield kind,raw[:declared]

    def close(self):
        if self.h: self.Close(self.h)
        self.h = HANDLE()
