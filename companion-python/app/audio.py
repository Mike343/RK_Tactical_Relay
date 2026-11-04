import ctypes as C
import logging
import wave

log = logging.getLogger("RK")


class Format(C.Structure):
    _pack_ = 1
    _fields_ = [("type",C.c_uint16),("channels",C.c_uint16),("rate",C.c_uint32),
                ("bytes_per_sec",C.c_uint32),("align",C.c_uint16),("bits",C.c_uint16),("extra",C.c_uint16)]


class Header(C.Structure):
    _fields_ = [("data",C.c_void_p),("length",C.c_uint32),("recorded",C.c_uint32),
                ("user",C.c_size_t),("flags",C.c_uint32),("loops",C.c_uint32),
                ("next",C.c_void_p),("reserved",C.c_size_t)]


class Voice:
    def __init__(self, dll, path):
        with wave.open(str(path),"rb") as f:
            channels, width, rate, frames, _, _ = f.getparams()
            pcm=f.readframes(frames)
        self.dll=dll
        self.data=C.create_string_buffer(pcm)
        self.h=C.c_void_p()
        self.header=None
        self.gain=None
        fmt=Format(1,channels,rate,rate*channels*width,channels*width,width*8,0)
        self.check(dll.waveOutOpen(C.byref(self.h),0xffffffff,C.byref(fmt),0,0,0))

    @staticmethod
    def check(code):
        if code: raise OSError(f"waveOut error {code}")

    def volume(self,value):
        value=max(0,min(65535,int(value*65.535)))
        if value!=self.gain:
            self.dll.waveOutSetVolume(self.h,value | value<<16)
            self.gain=value

    def stop(self):
        if self.header is not None:
            self.check(self.dll.waveOutReset(self.h))
            self.check(self.dll.waveOutUnprepareHeader(self.h,C.byref(self.header),C.sizeof(Header)))
            self.header=None

    def play(self,loop=False):
        self.stop()
        hdr=Header(C.addressof(self.data),len(self.data)-1,0,0,12 if loop else 0,0xffffffff if loop else 0,None,0)
        self.check(self.dll.waveOutPrepareHeader(self.h,C.byref(hdr),C.sizeof(Header)))
        self.header=hdr
        self.check(self.dll.waveOutWrite(self.h,C.byref(hdr),C.sizeof(Header)))

    def close(self):
        self.stop()
        self.dll.waveOutClose(self.h)


class Audio:
    def __init__(self,root,cfg):
        dll=C.WinDLL("winmm")
        self.voices={}
        self.launch_gain = int(1000*float(cfg.get("launch_volume","0.15")))
        self.active_gain = int(1000*float(cfg.get("active_volume","0.35")))
        self.manual=self.active=False
        self.last_launch=self.last_impact=None
        for name,path in [("launch","enemy_missile_launch.wav"),("active","enemy_missile_in_air_loop.wav"),
                          ("gun","brrrt.wav"),("impact","Explosion.wav")]:
            try: self.voices[name]=Voice(dll,root/"Audio"/path)
            except (OSError,wave.Error) as e: log.warning("Audio %s unavailable: %s",name,e)

    def loop(self,name,on,gain):
        voice=self.voices.get(name)
        if voice:
            try:
                voice.volume(gain)
                if on and voice.header is None: voice.play(True)
                if not on: voice.stop()
            except OSError as e: log.warning("Audio %s: %s",name,e)

    def once(self,name,gain):
        voice=self.voices.get(name)
        if voice:
            try:
                voice.volume(gain)
                voice.play()
            except OSError as e: log.warning("Audio %s: %s",name,e)

    def telemetry(self,words):
        launch,active,word=words[4],words[5],words[7]
        if self.last_launch is not None and self.last_launch!=launch: self.once("launch",self.launch_gain)
        impact,gun,level=word>>16,(word>>8)&255,word&255
        if self.last_impact is not None and self.last_impact!=impact and level: self.once("impact",level*1000/255)
        self.last_launch,self.last_impact=launch,impact
        self.active=bool(active)
        self.loop("active",self.active or self.manual,self.active_gain)
        self.loop("gun",bool(gun),gun*1000/255)

    def idle(self):
        self.active=False
        self.loop("gun",False,0)
        self.loop("active",self.manual,self.active_gain)

    def reset(self):
        self.manual=False
        self.last_launch=self.last_impact=None
        self.idle()

    def close(self):
        for voice in self.voices.values():
            try: voice.close()
            except OSError as e: log.warning("Audio close: %s",e)
