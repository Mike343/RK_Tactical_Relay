import ctypes as C
from array import array
import logging
import wave
import threading
import sys

log = logging.getLogger("RK")


class Format(C.Structure):
    _pack_ = 1
    _fields_ = [("type",C.c_uint16),("channels",C.c_uint16),("rate",C.c_uint32),
                ("bytes_per_sec",C.c_uint32),("align",C.c_uint16),("bits",C.c_uint16),("extra",C.c_uint16)]


class Header(C.Structure):
    _fields_ = [("data",C.c_void_p),("length",C.c_uint32),("recorded",C.c_uint32),
                ("user",C.c_size_t),("flags",C.c_uint32),("loops",C.c_uint32),
                ("next",C.c_void_p),("reserved",C.c_size_t)]


def scale_pcm(pcm, width, gain):
    """Per-sound amplitude only: preserve sample count, channels and sample rate."""
    gain = max(0, min(1000, int(gain)))
    if gain == 1000:
        return pcm
    if width == 1:
        return bytes(128 + int((sample - 128) * gain / 1000) for sample in pcm)
    if width in (2, 4):
        samples = array("h" if width == 2 else "i")
        samples.frombytes(pcm)
        if sys.byteorder != "little":
            samples.byteswap()
        for i, sample in enumerate(samples):
            samples[i] = int(sample * gain / 1000)
        if sys.byteorder != "little":
            samples.byteswap()
        return samples.tobytes()
    if width == 3:
        return b"".join(int(int.from_bytes(pcm[i:i+3], "little", signed=True) * gain / 1000)
                        .to_bytes(3, "little", signed=True) for i in range(0, len(pcm), 3))
    raise wave.Error("Unsupported PCM sample width")


class Voice:
    def __init__(self, dll, path):
        with wave.open(str(path), "rb") as f:
            channels, width, rate, frames, _, _ = f.getparams()
            self.pcm = f.readframes(frames)
        if not self.pcm:
            raise wave.Error("Empty audio file")
        self.width = width
        self.chunk_bytes = max(1, rate // 50) * channels * width
        self.dll = dll
        self.data = None
        self.h = C.c_void_p()
        self.header = None
        self.gain = 1000
        self._scaled_gain = None
        self._scaled_pcm = None
        self.lock = threading.RLock()
        fmt = Format(1, channels, rate, rate*channels*width, channels*width, width*8, 0)
        self.check(dll.waveOutOpen(C.byref(self.h), 0xffffffff, C.byref(fmt), 0, 0, 0))

    @staticmethod
    def check(code):
        if code:
            raise OSError(f"waveOut error {code}")

    def volume(self, value):
        # Never change the Windows device/session volume. Each sound owns its
        # sample amplitude; explosions and guns cannot change the warning gain.
        with self.lock:
            self.gain = max(0, min(1000, int(value)))

    def stop(self):
        with self.lock:
            if self.header is not None:
                self.check(self.dll.waveOutReset(self.h))
                self.check(self.dll.waveOutUnprepareHeader(self.h, C.byref(self.header), C.sizeof(Header)))
                self.header = None
                self.data = None

    def play(self, loop=False):
        with self.lock:
            self.stop()
            if self._scaled_gain != self.gain:
                self._scaled_pcm = scale_pcm(self.pcm, self.width, self.gain)
                self._scaled_gain = self.gain
            pcm = self._scaled_pcm
            self.data = C.create_string_buffer(pcm)
            hdr = Header(C.addressof(self.data), len(pcm), 0, 0,
                         12 if loop else 0, 0xffffffff if loop else 0, None, 0)
            self.check(self.dll.waveOutPrepareHeader(self.h, C.byref(hdr), C.sizeof(Header)))
            self.header = hdr
            self.check(self.dll.waveOutWrite(self.h, C.byref(hdr), C.sizeof(Header)))

    def close(self):
        with self.lock:
            self.stop()
            self.check(self.dll.waveOutClose(self.h))


class GunVoice(Voice):
    """Queue short gun buffers so distance gain changes do not restart its WAV.

    The cockpit warning uses Voice's full-file Windows loop, not this pump.
    Buffers already submitted to Windows are never modified.
    """
    def __init__(self, dll, path):
        super().__init__(dll, path)
        self.pending = []
        self.cursor = 0
        self.playing = False
        self.looping = False

    def stop(self):
        with self.lock:
            self.playing = False
            if self.pending:
                self.check(self.dll.waveOutReset(self.h))
            while self.pending:
                data, hdr = self.pending[0]
                if hdr.flags & 2:  # WHDR_PREPARED
                    self.check(self.dll.waveOutUnprepareHeader(self.h, C.byref(hdr), C.sizeof(Header)))
                self.pending.pop(0)
            self.header = None

    def play(self, loop=False):
        with self.lock:
            self.stop()
            self.cursor = 0
            self.looping = loop
            self.playing = True
            self.pump()

    def pump(self):
        with self.lock:
            while self.pending and self.pending[0][1].flags & 1:  # WHDR_DONE
                data, hdr = self.pending[0]
                self.check(self.dll.waveOutUnprepareHeader(self.h, C.byref(hdr), C.sizeof(Header)))
                self.pending.pop(0)
            while self.playing and len(self.pending) < 3:
                if self.cursor == len(self.pcm):
                    if not self.looping:
                        break
                    self.cursor = 0
                end = min(self.cursor + self.chunk_bytes, len(self.pcm))
                pcm = scale_pcm(self.pcm[self.cursor:end], self.width, self.gain)
                data = C.create_string_buffer(pcm)
                hdr = Header(C.addressof(data), len(pcm), 0, 0, 0, 0, None, 0)
                self.pending.append((data, hdr))  # retain through completion/reset
                self.check(self.dll.waveOutPrepareHeader(self.h, C.byref(hdr), C.sizeof(Header)))
                self.check(self.dll.waveOutWrite(self.h, C.byref(hdr), C.sizeof(Header)))
                self.cursor = end
            self.header = self.pending[0][1] if self.pending else None
            if self.header is None:
                self.playing = False


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
            try: self.voices[name]=(GunVoice if name=="gun" else Voice)(dll,root/"Audio"/path)
            except (OSError,wave.Error) as e: log.warning("Audio %s unavailable: %s",name,e)

        self._stopping = threading.Event()
        self._worker = threading.Thread(target=self._pump_gun, name="RK gun audio", daemon=True)
        self._worker.start()

    def _pump_gun(self):
        voice = self.voices.get("gun")
        if voice is None:
            return
        while not self._stopping.wait(0.005):
            try:
                voice.pump()
            except OSError as error:
                log.warning("Audio gun: %s", error)
                try:
                    voice.stop()
                except OSError:
                    return

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
        self._stopping.set()
        self._worker.join()
        for voice in self.voices.values():
            try: voice.close()
            except OSError as e: log.warning("Audio close: %s",e)
