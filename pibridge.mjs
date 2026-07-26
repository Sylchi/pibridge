#!/usr/bin/env node
/**
 * PiBridge — BLE Remote GPIO System
 * ==================================
 * Single file: dashboard + Pi firmware + provisioning + SD card prep.
 *
 * USB GADGET MODE (Pi Zero W — no WiFi, no SSH keys needed):
 *   The Pi Zero W can act as a USB Ethernet device when connected
 *   via the OTG port. Plug the data USB cable from laptop → Pi side
 *   port (NOT the power port). Pi shows up as a network interface
 *   at 10.0.0.2 (static) or raspberrypi.local (mDNS).
 *
 *   Then: dashboard provisions the Pi over this USB link.
 *   No router, no WiFi config, no SSH keys.
 *
 * QUICK START (one terminal command, then everything in browser):
 *   1. Insert SD card reader
 *   2. sudo node pibridge.mjs --prep-sd /dev/sdX   (prepares card)
 *   3. Put card in Pi, connect Pi to laptop via USB cable (side port)
 *   4. Open http://localhost:8080, click "Provision via USB"
 *   5. Click "Connect" → PiBridge appears via Bluetooth
 *
 * ALTERNATIVE (if you have WiFi + SSH):
 *   node pibridge.mjs                        Start dashboard
 *   node pibridge.mjs --deploy pi@<ip>       Deploy firmware via SSH
 *
 * OTHER USAGE:
 *   node pibridge.mjs --port 3000            Custom port
 *   node pibridge.mjs --open                 Open browser
 *   node pibridge.mjs --firmware             Print Python firmware
 *
 * EXPORTS (Node.js):
 *   import { PiBridgeClient, AudioEngine, PatternEngine,
 *            SceneManager, packDigitalWrite, unpackDigitalRead,
 *            packAudioBands, FIRMWARE } from './pibridge.mjs'
 *
 * ARCHITECTURE:
 *   Laptop
 *     ├── Browser dashboard ──BLE──► Pi Zero W
 *     │   (Web Bluetooth)             ├── GPIO/PWM/Servo
 *     ├── USB cable ──g_ether──────►  ├── WS2812 LEDs
 *     │   (provisioning only)         ├── MCP3008 ADC
 *     └── node pibridge.mjs           └── Digital inputs
 *           └── HTTP server :8080
 */

// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — EXPORTS (pure functions, testable, works in Node + Browser)
// ═════════════════════════════════════════════════════════════════════════════

// ─── Binary protocol helpers ─────────────────────────────────────────────────

export function packDigitalWrite(mask, values) {
  const b = new ArrayBuffer(8);
  const v = new DataView(b);
  v.setUint32(0, mask >>> 0, true);
  v.setUint32(4, values >>> 0, true);
  return b;
}

export function unpackDigitalRead(data) {
  const a = new Uint8Array(data);
  const r = [];
  for (let i = 0; i < a.length; i += 2) r.push({ pin: a[i], value: a[i + 1] });
  return r;
}

export function packAudioBands(bass, mid, treble, bpm, beat) {
  const b = new Uint8Array(6);
  b[0] = Math.max(0, Math.min(255, Math.round(bass)));
  b[1] = Math.max(0, Math.min(255, Math.round(mid)));
  b[2] = Math.max(0, Math.min(255, Math.round(treble)));
  b[3] = bpm & 0xFF;
  b[4] = (bpm >> 8) & 0xFF;
  b[5] = beat ? 1 : 0;
  return b;
}

// ─── AudioEngine — Web Audio FFT + beat detection ────────────────────────────

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.data = null;
    this.history = [];
    this.lastBeat = 0;
    this.bass = 0;
    this.mid = 0;
    this.treble = 0;
    this.bpm = 0;
    this.beat = false;
  }

  async start() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.source = this.ctx.createMediaStreamSource(s);
      this.source.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      return true;
    } catch (e) {
      console.error('AudioEngine.start:', e.message);
      return false;
    }
  }

  stop() {
    if (this.ctx) { this.ctx.close(); this.ctx = null; }
    this.analyser = null; this.source = null; this.data = null;
    this.history = [];
  }

  process() {
    if (!this.analyser || !this.data) return null;
    this.analyser.getByteFrequencyData(this.data);
    this.bass   = this._avg(0, 4);
    this.mid    = this._avg(4, 12);
    this.treble = this._avg(12, 32);
    const total = this.bass + this.mid + this.treble;
    this.history.push(total);
    if (this.history.length > 30) this.history.shift();
    const avg = this.history.reduce((a, b) => a + b, 0) / this.history.length;
    this.beat = this.history.length > 10 && total > avg * 1.3;
    const now = performance.now();
    if (this.beat) {
      const dt = now - this.lastBeat;
      if (dt > 200 && dt < 2000) this.bpm = Math.round(60000 / dt);
      this.lastBeat = now;
    }
    return this.state;
  }

  get state() {
    return { bass: Math.round(this.bass), mid: Math.round(this.mid),
             treble: Math.round(this.treble), bpm: this.bpm, beat: this.beat };
  }

  pack() { return packAudioBands(this.bass, this.mid, this.treble, this.bpm, this.beat); }

  _avg(s, e) { let sum = 0; for (let i = s; i < e; i++) sum += this.data[i]; return sum / (e - s); }
}

// ─── PatternEngine — LED frame generation (pure math, no DOM) ────────────────

export class PatternEngine {
  static generate(id, count, params, tick) {
    const f = new Uint8Array(count * 3);
    const { r = 255, g = 0, b = 0, speed = 80, audioState } = params;
    const s = speed / 255;

    if (id <= 0) { f.fill(0); return f; }
    if (id === 1) { for (let i = 0; i < count; i++) { f[i*3]=r; f[i*3+1]=g; f[i*3+2]=b; } return f; }
    if (id === 2) {
      for (let i = 0; i < count; i++) {
        const hue = ((i / count) + tick * s * 0.01) % 1.0;
        const [cr, cg, cb] = this._hsv(hue, 1, 1);
        f[i*3]=cr; f[i*3+1]=cg; f[i*3+2]=cb;
      }
      return f;
    }
    if (id === 3) {
      const br = Math.sin(tick * s * 0.05) * 0.5 + 0.5;
      for (let i = 0; i < count; i++) {
        f[i*3]=Math.round(r * br); f[i*3+1]=Math.round(g * br); f[i*3+2]=Math.round(b * br);
      }
      return f;
    }
    if (id === 4) {
      for (let i = 0; i < count; i++) {
        if (i % 3 === (tick % 3)) { f[i*3]=r; f[i*3+1]=g; f[i*3+2]=b; }
      }
      return f;
    }
    if (id === 5 && audioState) {
      const { bass, mid, treble, beat } = audioState;
      const bs = bass / 255, ms = mid / 255, ts = treble / 255;
      for (let i = 0; i < count; i++) {
        const p = i / count;
        if (p < 1/3) { f[i*3]=Math.round(bs*255); f[i*3+1]=0; f[i*3+2]=0; }
        else if (p < 2/3) { f[i*3]=0; f[i*3+1]=Math.round(ms*255); f[i*3+2]=0; }
        else { f[i*3]=0; f[i*3+1]=0; f[i*3+2]=Math.round(ts*255); }
      }
      if (beat) {
        for (let i = 0; i < count; i++) {
          f[i*3] = Math.min(255, f[i*3] + 200);
          f[i*3+1] = Math.min(255, f[i*3+1] + 200);
          f[i*3+2] = Math.min(255, f[i*3+2] + 200);
        }
      }
      return f;
    }
    f.fill(0);
    return f;
  }

  static _hsv(h, s, v) {
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    return [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i % 6].map(x => Math.round(x * 255));
  }
}

// ─── SceneManager — save/load pin states ──────────────────────────────────────

export class SceneManager {
  static save(name, pinStates) {
    return { name, pins: Object.keys(pinStates).length, state: { ...pinStates }, savedAt: Date.now() };
  }
  static load(storageFile) {
    if (typeof localStorage !== 'undefined') {
      try { return JSON.parse(localStorage.getItem('pibridge_scenes') || '[]'); } catch {}
    }
    if (storageFile) {
      try { const fs = require('fs'); if (fs.existsSync(storageFile)) return JSON.parse(fs.readFileSync(storageFile,'utf8')); } catch {}
    }
    return [];
  }
  static store(scenes, storageFile) {
    if (typeof localStorage !== 'undefined') localStorage.setItem('pibridge_scenes', JSON.stringify(scenes));
    if (storageFile) { try { const fs = require('fs'); fs.writeFileSync(storageFile, JSON.stringify(scenes, null, 2)); } catch {} }
  }
}

// ─── PiBridgeClient — BLE GATT client for browser ─────────────────────────────

export class PiBridgeClient {
  static SVC = '4d697272-6f72-0000-0000-000000000000';
  static CH = {
    pin_config:   '4d697272-6f72-0001-0000-000000000000',
    digital_out:  '4d697272-6f72-0002-0000-000000000000',
    digital_in:   '4d697272-6f72-0003-0000-000000000000',
    pwm:          '4d697272-6f72-0004-0000-000000000000',
    servo:        '4d697272-6f72-0005-0000-000000000000',
    analog:       '4d697272-6f72-0006-0000-000000000000',
    ws2812_frame: '4d697272-6f72-0007-0000-000000000000',
    ws2812_mode:  '4d697272-6f72-0008-0000-000000000000',
    audio:        '4d697272-6f72-0009-0000-000000000000',
    system:       '4d697272-6f72-000B-0000-000000000000',
  };

  constructor() {
    this.device = null;
    this.server = null;
    this.service = null;
    this.chars = {};
    this._onInput = null;
    this._onDisconnect = null;
    this._onSystem = null;
  }

  set onInput(cb) { this._onInput = cb; }
  set onDisconnect(cb) { this._onDisconnect = cb; }
  set onSystem(cb) { this._onSystem = cb; }

  get connected() { return this.server && this.server.connected; }

  async connect(filters) {
    filters = filters || [{ namePrefix: 'PiBridge' }];
    this.device = await navigator.bluetooth.requestDevice({
      filters,
      optionalServices: [PiBridgeClient.SVC],
    });
    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(PiBridgeClient.SVC);
    for (const [n, u] of Object.entries(PiBridgeClient.CH)) {
      this.chars[n] = await this.service.getCharacteristic(u);
    }

    if (this.chars.digital_in) {
      await this.chars.digital_in.startNotifications();
      this.chars.digital_in.addEventListener('characteristicvaluechanged', e => {
        if (this._onInput) this._onInput(unpackDigitalRead(e.target.value.buffer));
      });
    }

    if (this.chars.system) {
      await this.chars.system.startNotifications();
      this.chars.system.addEventListener('characteristicvaluechanged', e => {
        if (this._onSystem) this._onSystem(e.target.value);
      });
    }

    this.device.addEventListener('gattserverdisconnected', () => {
      this.server = null; this.service = null; this.chars = {};
      if (this._onDisconnect) this._onDisconnect();
    });
    return true;
  }

  disconnect() { if (this.device && this.device.gatt) this.device.gatt.disconnect(); }

  async digitalWrite(pins, values) {
    const pa = Array.isArray(pins) ? pins : [pins];
    const va = Array.isArray(values) ? values : [values];
    let mask = 0, vals = 0;
    for (let i = 0; i < pa.length; i++) { const b = 1 << pa[i]; mask |= b; if (va[i]) vals |= b; }
    await this.chars.digital_out.writeValue(packDigitalWrite(mask, vals));
  }

  async configPin(pin, mode, ...args) {
    let d;
    if (mode === 5) { const c = args[0]||60; d = new Uint8Array([pin,5,c&0xFF,(c>>8)&0xFF]); }
    else if (mode === 6) { d = new Uint8Array([pin,6,args[0]||0]); }
    else d = new Uint8Array([pin, mode]);
    await this.chars.pin_config.writeValue(d);
  }

  async setPwm(pin, duty, freq) {
    const b = new Uint8Array(freq ? 5 : 3);
    b[0] = pin; b[1] = Math.max(0, Math.min(100, Math.round(duty)));
    if (freq) { b[2] = freq & 0xFF; b[3] = (freq >> 8) & 0xFF; }
    await this.chars.pwm.writeValue(b);
  }

  async setServo(pin, pulse) {
    const b = new Uint8Array(3); b[0]=pin; b[1]=pulse&0xFF; b[2]=(pulse>>8)&0xFF;
    await this.chars.servo.writeValue(b);
  }

  async sendFrame(frame) { await this.chars.ws2812_frame.writeValue(frame); }

  async setPattern(pin, pid, params) {
    params = params || {};
    const { r=0, g=0, b=0, speed=80 } = params;
    await this.chars.ws2812_mode.writeValue(new Uint8Array([pin, pid, speed, r, g, b]));
  }

  async sendAudio(bass, mid, treble, bpm, beat) {
    await this.chars.audio.writeValue(packAudioBands(bass, mid, treble, bpm, beat));
  }

  async getStatus() { await this.chars.system.writeValue(new Uint8Array([0])); }
  async reboot() { await this.chars.system.writeValue(new Uint8Array([1])); }
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — PI FIRMWARE (Python, BlueZ D-Bus GATT server — validated)
// ═════════════════════════════════════════════════════════════════════════════

export const FIRMWARE = `#!/usr/bin/env python3
"""PiBridge Firmware — BLE Remote GPIO for Pi Zero W.
Uses BlueZ D-Bus GATT server. No pip packages required (uses pydbus from apt).

Install:  sudo apt install python3-pip python3-pydbus bluez pi-bluetooth
          pip3 install rpi-ws281x spidev RPi.GPIO
Run:      sudo python3 /opt/pibridge.py

Auto-start:
  sudo tee /etc/systemd/system/pibridge.service <<'EOF'
[Unit]
Description=PiBridge BLE Remote GPIO
After=bluetooth.target

[Service]
ExecStart=/usr/bin/python3 /opt/pibridge.py
Restart=always
User=root

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl enable --now pibridge
"""
import sys, struct, json, os, time, logging, traceback
from threading import Lock

logging.basicConfig(level=logging.INFO, format="[PiBridge] %(message)s")
log = logging.getLogger("PiBridge")

# ── UUIDs (match JS side) ────────────────────────────────────────────────
SVC_UUID     = "4d697272-6f72-0000-0000-000000000000"
PIN_CONFIG   = "4d697272-6f72-0001-0000-000000000000"
DIGITAL_OUT  = "4d697272-6f72-0002-0000-000000000000"
DIGITAL_IN   = "4d697272-6f72-0003-0000-000000000000"
PWM_CHAR     = "4d697272-6f72-0004-0000-000000000000"
SERVO_CHAR   = "4d697272-6f72-0005-0000-000000000000"
ANALOG_CHAR  = "4d697272-6f72-0006-0000-000000000000"
WS2812_FRAME = "4d697272-6f72-0007-0000-000000000000"
WS2812_MODE  = "4d697272-6f72-0008-0000-000000000000"
AUDIO_CHAR   = "4d697272-6f72-0009-0000-000000000000"
SYSTEM_CHAR  = "4d697272-6f72-000B-0000-000000000000"

# ── Hardware abstraction layer (graceful fallbacks) ──────────────────────
class Hardware:
    def __init__(self):
        self.has_gpio = False; self.has_neopixel = False; self.has_spi = False
        self.gpio = None; self.np = None; self.led_count = 0; self.spi = None
        self.pwm_map = {}  # pin -> PWM instance
        self._init_gpio()
        self._init_neopixel()
        self._init_spi()

    def _init_gpio(self):
        try:
            import RPi.GPIO as GPIO
            GPIO.setmode(GPIO.BCM); GPIO.setwarnings(False)
            self.gpio = GPIO; self.has_gpio = True
            log.info("GPIO: RPi.GPIO ready")
        except Exception as e:
            log.warning(f"RPi.GPIO unavailable: {e}")

    def _init_neopixel(self):
        try:
            import board, neopixel as np
            self.np_lib = np; self.board = board
            self.has_neopixel = True
            log.info("WS2812: neopixel library ready")
        except Exception as e:
            log.warning(f"neopixel unavailable: {e}")

    def _init_spi(self):
        try:
            import spidev
            self.spi_dev = spidev.SpiDev()
            self.spi_dev.open(0, 0)
            self.spi_dev.max_speed_hz = 1000000
            self.has_spi = True
            log.info("ADC: spidev ready (MCP3008 on SPI0)")
        except Exception as e:
            log.warning(f"spidev unavailable: {e}")

    # ── GPIO operations ──────────────────────────────────────────────────
    def pin_mode(self, pin, mode, **kw):
        if not self.has_gpio: return
        self._cleanup_pin(pin)
        if mode == 0:  # OFF / input
            self.gpio.setup(pin, self.gpio.IN, pull_up_down=self.gpio.PUD_OFF)
        elif mode == 1:  # DIN
            pull = kw.get('pull', self.gpio.PUD_OFF)
            self.gpio.setup(pin, self.gpio.IN, pull_up_down=pull)
        elif mode == 2:  # DOUT
            init = self.gpio.HIGH if kw.get('initial', 0) else self.gpio.LOW
            self.gpio.setup(pin, self.gpio.OUT, initial=init)
        elif mode == 3:  # PWM
            freq = kw.get('freq', 1000)
            self.gpio.setup(pin, self.gpio.OUT)
            p = self.gpio.PWM(pin, freq)
            p.start(kw.get('duty', 0))
            self.pwm_map[pin] = p
        elif mode == 4:  # Servo
            self.gpio.setup(pin, self.gpio.OUT)
            p = self.gpio.PWM(pin, 50)
            p.start(0)
            self.pwm_map[pin] = p

    def _cleanup_pin(self, pin):
        if pin in self.pwm_map:
            self.pwm_map[pin].stop()
            del self.pwm_map[pin]

    def digital_write(self, mask, values):
        if not self.has_gpio: return
        for pin in range(28):
            bit = 1 << pin
            if mask & bit:
                self.gpio.output(pin, self.gpio.HIGH if (values & bit) else self.gpio.LOW)

    def digital_read(self, pin):
        if not self.has_gpio: return 0
        return self.gpio.input(pin)

    def pwm_write(self, pin, duty, freq=None):
        if pin not in self.pwm_map: return
        if freq: self.pwm_map[pin].ChangeFrequency(freq)
        self.pwm_map[pin].ChangeDutyCycle(duty)

    def servo_write(self, pin, us):
        if pin not in self.pwm_map: return
        duty = (us / 20000.0) * 100
        self.pwm_map[pin].ChangeDutyCycle(duty)

    def ws2812_init(self, pin, count):
        if not self.has_neopixel: return
        if self.np: self.np.deinit()
        pin_attr = getattr(self.board, f"D{pin}", self.board.D18)
        self.np = self.np_lib.NeoPixel(pin_attr, count, brightness=0.5,
                                       auto_write=False, pixel_order=self.np_lib.GRB)
        self.led_count = count
        log.info(f"WS2812: {count} LEDs on GPIO{pin}")

    def ws2812_write(self, data):
        if not self.np: return
        n = min(len(data) // 3, self.led_count)
        for i in range(n):
            self.np[i] = (data[i*3], data[i*3+1], data[i*3+2])
        self.np.show()

    def analog_read(self, channel):
        if not self.has_spi: return 0
        r = self.spi_dev.xfer2([1, (8 + channel) << 4, 0])
        return ((r[1] & 3) << 8) + r[2]


# ── BlueZ D-Bus GATT Server ─────────────────────────────────────────────
# Uses pydbus to implement a GATT service via BlueZ's GattManager1 API.
# This is the standard, well-tested approach on Linux/Raspberry Pi.

try:
    import pydbus
    from gi.repository import GLib
    HAS_DBUS = True
except:
    HAS_DBUS = False
    log.error("pydbus not installed. Run: sudo apt install python3-pydbus")


class GattService:
    dbus = '''<node>
        <interface name="org.bluez.GattService1">
            <property name="UUID" type="s" access="read"/>
            <property name="Primary" type="b" access="read"/>
            <property name="Includes" type="ao" access="read"/>
        </interface>
    </node>'''
    def __init__(self, path, uuid, primary=True):
        self.path = path
        self.uuid = uuid
        self.primary = primary
        self.includes = []
    @property
    def UUID(self): return self.uuid
    @property
    def Primary(self): return self.primary
    @property
    def Includes(self): return self.includes


class GattCharacteristic:
    dbus = '''<node>
        <interface name="org.bluez.GattCharacteristic1">
            <property name="UUID" type="s" access="read"/>
            <property name="Service" type="o" access="read"/>
            <property name="Value" type="ay" access="read"/>
            <property name="Flags" type="as" access="read"/>
            <property name="Notifying" type="b" access="read"/>
            <method name="ReadValue">
                <arg type="ay" name="value" direction="out"/>
                <arg name="options" type="a{sv}" direction="in"/>
            </method>
            <method name="WriteValue">
                <arg type="ay" name="value" direction="in"/>
                <arg name="options" type="a{sv}" direction="in"/>
            </method>
            <method name="StartNotify"/>
            <method name="StopNotify"/>
            <signal name="PropertiesChanged">
                <arg type="s" name="interface"/>
                <arg type="a{sv}" name="changed_properties"/>
                <arg type="as" name="invalidated_properties"/>
            </signal>
        </interface>
    </node>'''
    def __init__(self, path, uuid, flags, service_path, read_fn=None, write_fn=None):
        self.path = path
        self.uuid = uuid
        self.flags = flags
        self.service_path = service_path
        self.read_fn = read_fn
        self.write_fn = write_fn
        self._value = b''
        self._notifying = False
        self._bus = None

    @property
    def UUID(self): return self.uuid
    @property
    def Service(self): return self.service_path
    @property
    def Value(self): return list(self._value)
    @property
    def Flags(self): return self.flags
    @property
    def Notifying(self): return self._notifying

    def ReadValue(self, options):
        if self.read_fn: self._value = self.read_fn(self) or b''
        log.debug(f"Read {self.uuid}: {len(self._value)}b")
        return list(self._value)

    def WriteValue(self, value, options):
        self._value = bytes(value)
        if self.write_fn:
            try: self.write_fn(self, self._value)
            except Exception as e: log.error(f"Write handler: {e}\\n{traceback.format_exc()}")

    def StartNotify(self):
        self._notifying = True
        log.info(f"Notifications started: {self.uuid}")

    def StopNotify(self):
        self._notifying = False

    def notify(self, data):
        """Send notification to connected client via PropertiesChanged."""
        if not self._notifying or not self._bus: return
        self._value = bytes(data)
        try:
            self._bus.send(
                'org.bluez', self.path,
                'org.freedesktop.DBus.Properties',
                'PropertiesChanged',
                'sa{sv}as',
                ('org.bluez.GattCharacteristic1',
                 {'Value': GLib.Variant('ay', list(self._value))},
                 [])
            )
        except Exception as e:
            log.warning(f"notify failed: {e}")


# ── Application ─────────────────────────────────────────────────────────
class PiBridgeApp:
    def __init__(self, hw):
        self.hw = hw
        self.bus = None
        self.mainloop = GLib.MainLoop()
        self.service = None
        self.chars = {}
        self.audio_state = {'bass': 0, 'mid': 0, 'treble': 0, 'bpm': 120, 'beat': False}
        self._din_state = {}  # for change detection

    def run(self):
        if not HAS_DBUS:
            log.error("Cannot start — pydbus not available")
            sys.exit(1)

        self.bus = pydbus.SystemBus()
        self._setup_gatt()

        # Register application with BlueZ
        try:
            adapter = self.bus.get('org.bluez', '/org/bluez/hci0')
            # Power on if needed
            if not adapter.Powered:
                adapter.Powered = True
                log.info("Bluetooth powered on")

            gatt_mgr = self.bus.get('org.bluez', '/org/bluez/hci0/gatt_manager')
            app_path = '/io/pibridge'
            self.bus.register_object(app_path, self.service, None)
            for ch in self.chars.values():
                self.bus.register_object(ch.path, ch, None)
                ch._bus = self.bus

            gatt_mgr.RegisterApplication(app_path, {})
            log.info("GATT application registered")

            # Start advertising
            props = {
                'Type': 'peripheral',
                'ServiceUUIDs': GLib.Variant('as', [SVC_UUID]),
                'Discoverable': True,
                'DiscoverableTimeout': GLib.Variant('u', 0),
                'LocalName': GLib.Variant('s', 'PiBridge'),
            }
            adapter.SetDiscoveryFilter(props)
            log.info("Advertising as PiBridge")

        except Exception as e:
            log.error(f"BlueZ setup failed: {e}\\n{traceback.format_exc()}")
            log.info("Try: sudo hciconfig hci0 up && sudo systemctl restart bluetooth")
            sys.exit(1)

        # Start input polling
        GLib.timeout_add(100, self._poll_inputs)
        log.info("PiBridge ready — connect via Bluetooth")
        log.info(f"  Service UUID: {SVC_UUID}")

        try:
            self.mainloop.run()
        except KeyboardInterrupt:
            pass
        finally:
            self._cleanup()

    def _setup_gatt(self):
        BASE = '/io/pibridge'
        # Create service
        self.service = GattService(BASE, SVC_UUID, True)

        # Define characteristics: (name, uuid, flags, handler)
        char_defs = [
            ('pin_config',   PIN_CONFIG,   ['write'], None, self._on_pin_config),
            ('digital_out',  DIGITAL_OUT,  ['write', 'write-without-response'], None, self._on_digital_out),
            ('digital_in',   DIGITAL_IN,   ['read', 'notify'], self._read_digital_in, None),
            ('pwm',          PWM_CHAR,     ['write', 'write-without-response'], None, self._on_pwm),
            ('servo',        SERVO_CHAR,   ['write', 'write-without-response'], None, self._on_servo),
            ('analog',       ANALOG_CHAR,  ['read'], self._read_analog, None),
            ('ws2812_frame', WS2812_FRAME, ['write', 'write-without-response'], None, self._on_ws2812_frame),
            ('ws2812_mode',  WS2812_MODE,  ['write', 'write-without-response'], None, self._on_ws2812_mode),
            ('audio',        AUDIO_CHAR,   ['write', 'write-without-response'], None, self._on_audio),
            ('system',       SYSTEM_CHAR,  ['write', 'read', 'notify'], self._read_system, self._on_system),
        ]

        for i, (name, uuid, flags, rfn, wfn) in enumerate(char_defs):
            ch_path = f'{BASE}/char{i}'
            ch = GattCharacteristic(ch_path, uuid, flags, BASE, rfn, wfn)
            self.chars[name] = ch

    # ── Characteristic handlers ──────────────────────────────────────────

    def _on_pin_config(self, ch, data):
        if len(data) < 2: return
        pin, mode = data[0], data[1]
        args = {}
        if mode == 5 and len(data) >= 4:
            count = struct.unpack('<H', data[2:4])[0]
            self.hw.ws2812_init(pin, count)
        elif mode == 6 and len(data) >= 3:
            args['channel'] = data[2]
        self.hw.pin_mode(pin, mode, **args)
        log.info(f"Pin {pin} → mode {mode}")

    def _on_digital_out(self, ch, data):
        if len(data) >= 8:
            mask = struct.unpack('<I', data[:4])[0]
            vals = struct.unpack('<I', data[4:8])[0]
            self.hw.digital_write(mask, vals)

    def _read_digital_in(self, ch):
        result = bytearray()
        for pin in range(28):
            val = self.hw.digital_read(pin)
            result.extend(struct.pack('BB', pin, val))
        return bytes(result)

    def _on_pwm(self, ch, data):
        if len(data) >= 2:
            pin, duty = data[0], data[1]
            freq = struct.unpack('<H', data[2:4])[0] if len(data) >= 4 else None
            self.hw.pwm_write(pin, duty, freq)

    def _on_servo(self, ch, data):
        if len(data) >= 3:
            pin, us = data[0], struct.unpack('<H', data[1:3])[0]
            self.hw.servo_write(pin, us)

    def _read_analog(self, ch):
        result = bytearray()
        for ch_num in range(8):
            val = self.hw.analog_read(ch_num)
            result.extend(struct.pack('BH', ch_num, val))
        return bytes(result)

    def _on_ws2812_frame(self, ch, data):
        self.hw.ws2812_write(data)

    def _on_ws2812_mode(self, ch, data):
        if len(data) < 2: return
        pin, pat_id = data[0], data[1]
        if pat_id == 0 and self.hw.np:
            self.hw.np.fill((0, 0, 0))
            self.hw.np.show()
        elif pat_id == 1 and len(data) >= 6 and self.hw.np:
            r, g, b = data[3], data[4], data[5]
            self.hw.np.fill((r, g, b))
            self.hw.np.show()
        log.info(f"Pattern {pat_id} on pin {pin}")

    def _on_audio(self, ch, data):
        if len(data) >= 6:
            self.audio_state['bass'] = data[0]
            self.audio_state['mid'] = data[1]
            self.audio_state['treble'] = data[2]
            self.audio_state['bpm'] = struct.unpack('<H', data[3:5])[0]
            self.audio_state['beat'] = bool(data[5])

    def _read_system(self, ch):
        st = json.dumps({
            'pins': 28,
            'patterns': 0,
            'audio': self.audio_state,
        })
        return st.encode()

    def _on_system(self, ch, data):
        if len(data) >= 1 and data[0] == 1:
            log.info("Reboot command received")
            os.system('sudo reboot &')

    # ── Input change polling ─────────────────────────────────────────────

    def _poll_inputs(self):
        """Check digital inputs for changes and notify browser."""
        if not self.hw.has_gpio or 'digital_in' not in self.chars:
            return True  # keep timer alive

        changed = bytearray()
        for pin in range(28):
            try:
                val = self.hw.digital_read(pin)
                if self._din_state.get(pin) != val:
                    self._din_state[pin] = val
                    changed.extend(struct.pack('BB', pin, val))
            except:
                pass

        if changed:
            self.chars['digital_in'].notify(bytes(changed))

        return True  # keep GLib timer alive

    def _cleanup(self):
        if self.hw.has_gpio:
            self.hw.gpio.cleanup()
        log.info("PiBridge stopped")


# ── Entry point ─────────────────────────────────────────────────────────
if __name__ == '__main__':
    if os.geteuid() != 0:
        log.warning("Not running as root — GPIO and BLE may fail")
    hw = Hardware()
    app = PiBridgeApp(hw)
    app.run()
`;


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — NODE.JS SERVER (dashboard + provisioning API)
// ═════════════════════════════════════════════════════════════════════════════

import http from 'http';
import url from 'url';
import fs from 'fs';
import { execSync, exec } from 'child_process';

const isMain = process.argv[1] && (
  process.argv[1].endsWith('pibridge.mjs') ||
  process.argv[1].endsWith('pibridge.js')
);

if (isMain) {
  // ── CLI flags ──────────────────────────────────────────────────────────
  if (process.argv.includes('--firmware')) {
    console.log(FIRMWARE);
    process.exit(0);
  }

  // ── SD card prep ─────────────────────────────────────────────────––—
  const prepIdx = process.argv.indexOf('--prep-sd');
  if (prepIdx !== -1 && prepIdx + 1 < process.argv.length) {
    const device = process.argv[prepIdx + 1];
    // Auto-detect if no device given, or use ChromeOS path
    if (device === 'auto' || !device) {
      // Look for mounted boot partitions
      try {
        const mounts = execSync('mount | grep -E "boot|raspberry" | head -5', { timeout: 3000 }).toString();
        if (mounts) {
          console.log('📂 Found mounted partitions:');
          console.log(mounts);
          console.log('   You can also manually specify: node pibridge.mjs --prep-sd /dev/sdX');
        }
      } catch {}
      console.log('');
      console.log('💡 On ChromeOS: use the dashboard instead!');
      console.log('   1. Start: node pibridge.mjs --open');
      console.log('   2. Open http://localhost:8080');
      console.log('   3. Go to "SD Card Prep" section');
      console.log('   4. Download the SD extras zip');
      console.log('   5. Extract it onto the boot partition via Files app');
      process.exit(0);
    }
    if (!device.match(/^\/dev\/sd[a-z]\d?$/) && !device.match(/^\/dev\/mmcblk\d+$/)) {
      console.error('❌ Invalid device. Use something like /dev/sda or /dev/mmcblk0');
      process.exit(1);
    }
    console.log(`📀 Preparing SD card at ${device}...`);
    console.log('   MAKE SURE you flashed Raspberry Pi OS Lite first!');
    console.log('   If not, press Ctrl+C and flash it first with rpi-imager.');
    console.log('');

    try {
      // Find boot partition
      const bootPart = fs.existsSync(device + '1') ? device + '1'
        : fs.existsSync(device + 'p1') ? device + 'p1'
        : null;
      const rootPart = fs.existsSync(device + '2') ? device + '2'
        : fs.existsSync(device + 'p2') ? device + 'p2'
        : null;

      if (!bootPart) { console.error('❌ Cannot find boot partition'); process.exit(1); }

      // Mount
      const mnt = '/mnt/pibridge_boot';
      execSync(`mkdir -p ${mnt} && sudo mount ${bootPart} ${mnt}`);

      // Enable SSH (empty file)
      execSync(`sudo touch ${mnt}/ssh`);
      console.log('✅ SSH enabled');

      // Enable USB gadget mode
      const configTxt = fs.readFileSync(`${mnt}/config.txt`, 'utf-8');
      if (!configTxt.includes('dtoverlay=dwc2')) {
        fs.writeFileSync(`${mnt}/config.txt`, configTxt + '\ndtoverlay=dwc2\n');
        console.log('✅ USB gadget (dwc2) enabled in config.txt');
      } else {
        console.log('   dwc2 already in config.txt');
      }

      const cmdlinePath = `${mnt}/cmdline.txt`;
      let cmdline = fs.readFileSync(cmdlinePath, 'utf-8').trim();
      if (!cmdline.includes('modules-load=dwc2,g_ether')) {
        cmdline = cmdline + ' modules-load=dwc2,g_ether';
        fs.writeFileSync(cmdlinePath, cmdline);
        console.log('✅ USB Ethernet gadget enabled in cmdline.txt');
      } else {
        console.log('   g_ether already in cmdline.txt');
      }

      // Unmount boot
      execSync(`sudo umount ${mnt}`);

      // Now handle root partition if available
      if (rootPart) {
        const rootMnt = '/mnt/pibridge_root';
        execSync(`mkdir -p ${rootMnt} && sudo mount ${rootPart} ${rootMnt}`);

        // Copy firmware
        const optDir = `${rootMnt}/opt`;
        execSync(`sudo mkdir -p ${optDir}`);
        fs.writeFileSync(`${optDir}/pibridge.py`, FIRMWARE);
        console.log('✅ Firmware copied to /opt/pibridge.py');

        // Create systemd service
        const svcDir = `${rootMnt}/etc/systemd/system`;
        const svcContent = `[Unit]
Description=PiBridge BLE Remote GPIO
After=bluetooth.target network.target
Wants=bluetooth.target

[Service]
ExecStart=/usr/bin/python3 /opt/pibridge.py
Restart=always
User=root

[Install]
WantedBy=multi-user.target
`;
        fs.writeFileSync(`${svcDir}/pibridge.service`, svcContent);
        console.log('✅ Systemd service created (auto-starts on boot)');

        // Enable by creating symlink
        execSync(`sudo ln -sf ${svcDir}/pibridge.service ${rootMnt}/etc/systemd/system/multi-user.target.wants/pibridge.service`);

        execSync(`sudo umount ${rootMnt}`);
        console.log('✅ Service enabled for auto-start');
      } else {
        console.log('⚠️ Root partition not found — firmware will NOT be pre-loaded.');
        console.log('   The Pi will boot with USB gadget mode enabled.');
        console.log('   You can then use the dashboard to deploy firmware via USB serial.');
      }

      console.log('');
      console.log('🎉 SD card ready!');
      console.log('   Next steps:');
      console.log('   1. Put card in Pi Zero W');
      console.log('   2. Connect Pi to laptop via USB cable (side micro USB port)');
      console.log('   3. Wait 30s for Pi to boot');
      console.log('   4. The Pi appears as a USB Ethernet device');
      console.log('   5. Open http://localhost:8080 in browser');
      console.log('   6. Go to "Provision via USB" section');
      console.log('   7. Click "Provision" → done!');
      process.exit(0);

    } catch (e) {
      console.error('❌ Failed:', e.message);
      try { execSync('sudo umount /mnt/pibridge_boot 2>/dev/null; sudo umount /mnt/pibridge_root 2>/dev/null'); } catch {}
      process.exit(1);
    }
  }

  const portIdx = process.argv.indexOf('--port');
  const PORT = parseInt(
    process.argv.find(a => a.startsWith('--port='))?.split('=')[1] ||
    (portIdx !== -1 ? process.argv[portIdx + 1] : '8080'), 10
  );
  const SHOULD_OPEN = process.argv.includes('--open') || process.argv.includes('-o');

  // Read dashboard from comment block
  const source = fs.readFileSync(process.argv[1] || __filename, 'utf8');
  const dashMatch = source.match(/__DASHBOARD__\n([\s\S]*?)\n__DASHBOARD__/);
  const DASHBOARD_HTML = dashMatch ? dashMatch[1].trim() : '<h1>Dashboard not embedded</h1>';

  const server = http.createServer((req, res) => {
    const path = url.parse(req.url).pathname;
    const method = req.method;

    // ── Serve dashboard ──────────────────────────────────────────────
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      res.end(DASHBOARD_HTML);
      return;
    }

    // ── Serve firmware download ──────────────────────────────────────
    if (path === '/pibridge.py') {
      res.writeHead(200, {
        'Content-Type': 'text/x-python; charset=utf-8',
        'Content-Disposition': 'attachment; filename="pibridge.py"',
      });
      res.end(FIRMWARE);
      return;
    }

    // ── Serve this file for module imports ───────────────────────────
    if (path === '/pibridge.mjs') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(source);
      return;
    }

    // ── API: Deploy firmware to Pi via SSH ───────────────────────────
    if (path === '/api/deploy' && method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        let target = '';
        try {
          const j = JSON.parse(body);
          target = j.target || '';
        } catch { target = body.trim(); }

        if (!target) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Missing target (e.g. pi@192.168.1.42)' }));
          return;
        }

        // Stream deploy progress
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });

        const send = (type, data) => {
          res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        send('log', { message: `Deploying to ${target}...` });

        // Copy firmware
        exec(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${target} 'cat > /home/pi/pibridge.py'`, {
          input: FIRMWARE,
          timeout: 30000,
        }, (err) => {
          if (err) {
            send('error', { message: `SSH failed: ${err.message}` });
            res.end();
            return;
          }
          send('log', { message: '✅ Firmware copied' });
          send('log', { message: '📦 Installing dependencies (2-3 min)...' });

          // Install dependencies
          const installCmd = `ssh -o StrictHostKeyChecking=no ${target} \
            "sudo apt update -qq && \
             sudo apt install -y -qq python3-pip python3-pydbus bluez pi-bluetooth && \
             pip3 install --user rpi-ws281x spidev RPi.GPIO && \
             sudo cp /home/pi/pibridge.py /opt/ && \
             echo '===DONE==='"`;

          exec(installCmd, { timeout: 300000 }, (err2, stdout) => {
            if (err2) {
              send('error', { message: `Install failed: ${err2.message}\n${stdout || ''}` });
              res.end();
              return;
            }
            send('log', { message: '✅ Dependencies installed' });

            // Setup systemd service
            const svcCmd = `ssh -o StrictHostKeyChecking=no ${target} "
              sudo tee /etc/systemd/system/pibridge.service << 'SVC'
[Unit]
Description=PiBridge BLE Remote GPIO
After=bluetooth.target

[Service]
ExecStart=/usr/bin/python3 /opt/pibridge.py
Restart=always
User=root

[Install]
WantedBy=multi-user.target
SVC
sudo systemctl daemon-reload
sudo systemctl enable --now pibridge
echo '===SVC_DONE==='
"`;
            exec(svcCmd, { timeout: 30000 }, (err3, stdout3) => {
              if (err3) {
                send('log', { message: `⚠️ Service setup issue: ${err3.message}` });
              }
              if (stdout3?.includes('SVC_DONE')) {
                send('log', { message: '✅ Auto-start service enabled' });
              }
              send('log', { message: '🎉 Deploy complete! The Pi is now advertising as "PiBridge" via Bluetooth.' });
              send('log', { message: 'Open the dashboard and click "Connect" to find it.' });
              send('done', { success: true });
              res.end();
            });
          });
        });
      });
      return;
    }

    // ── Serve SD card setup script ──────────────────────────────────
    if (path === '/setup-pi.sh') {
      const script = `#!/bin/bash
# PiBridge SD card setup script
# Generated from pibridge.mjs
#
# Usage: sudo bash setup-pi.sh /dev/sdX
# Or:    sudo bash setup-pi.sh /dev/mmcblk0
#
# Prerequisites: Raspberry Pi OS Lite already flashed to the card.

set -e
DEVICE="\${1:-}"
if [ -z "$DEVICE" ]; then
  echo "Usage: sudo bash setup-pi.sh /dev/sdX"
  echo "Make sure you flashed Raspberry Pi OS Lite first!"
  exit 1
fi

echo "📀 Preparing SD card at $DEVICE..."

# Find partitions
if [ -e "\${DEVICE}1" ]; then
  BOOT="\${DEVICE}1"
elif [ -e "\${DEVICE}p1" ]; then
  BOOT="\${DEVICE}p1"
else
  echo "❌ Cannot find boot partition"
  exit 1
fi

if [ -e "\${DEVICE}2" ]; then
  ROOT="\${DEVICE}2"
elif [ -e "\${DEVICE}p2" ]; then
  ROOT="\${DEVICE}p2"
else
  ROOT=""
fi

# Mount boot
mkdir -p /mnt/pibridge_boot
mount "$BOOT" /mnt/pibridge_boot

# Enable SSH
touch /mnt/pibridge_boot/ssh
echo "✅ SSH enabled"

# Enable USB gadget mode
if ! grep -q dtoverlay=dwc2 /mnt/pibridge_boot/config.txt 2>/dev/null; then
  echo "dtoverlay=dwc2" >> /mnt/pibridge_boot/config.txt
  echo "✅ USB gadget enabled"
fi

if ! grep -q modules-load=dwc2,g_ether /mnt/pibridge_boot/cmdline.txt 2>/dev/null; then
  sed -i 's/$/ modules-load=dwc2,g_ether/' /mnt/pibridge_boot/cmdline.txt
  echo "✅ USB Ethernet gadget enabled"
fi

umount /mnt/pibridge_boot

# Mount root if available
if [ -n "$ROOT" ]; then
  mkdir -p /mnt/pibridge_root
  mount "$ROOT" /mnt/pibridge_root
  
  mkdir -p /mnt/pibridge_root/opt
  
  # Copy firmware (downloaded separately, or place pibridge.py in current dir)
  if [ -f ./pibridge.py ]; then
    cp ./pibridge.py /mnt/pibridge_root/opt/pibridge.py
    chmod +x /mnt/pibridge_root/opt/pibridge.py
    echo "✅ Firmware copied to /opt/pibridge.py"
  fi
  
  # Create systemd service
  cat > /mnt/pibridge_root/etc/systemd/system/pibridge.service << 'SVC'
[Unit]
Description=PiBridge BLE Remote GPIO
After=bluetooth.target network.target
Wants=bluetooth.target

[Service]
ExecStart=/usr/bin/python3 /opt/pibridge.py
Restart=always
User=root

[Install]
WantedBy=multi-user.target
SVC
  
  # Enable service
  mkdir -p /mnt/pibridge_root/etc/systemd/system/multi-user.target.wants
  ln -sf /etc/systemd/system/pibridge.service \
    /mnt/pibridge_root/etc/systemd/system/multi-user.target.wants/pibridge.service
  
  umount /mnt/pibridge_root
  echo "✅ Auto-start service enabled"
fi

echo ""
echo "🎉 SD card ready! Next steps:"
echo "  1. Put card in Pi Zero W"
echo "  2. Connect Pi to laptop via USB cable (SIDE micro USB port, NOT the power one)"
echo "  3. Wait 30s for Pi to boot"
echo "  4. The Pi appears as USB Ethernet at 10.0.0.2 or raspberrypi.local"
echo "  5. Open http://localhost:8080 and go to Provision section"
echo "  6. Click Provision via USB → done!"
`;
      res.writeHead(200, {
        'Content-Type': 'text/x-shellscript; charset=utf-8',
        'Content-Disposition': 'attachment; filename="setup-pi.sh"',
      });
      res.end(script);
      return;
    }

    // ── API: Check Pi status ─────────────────────────────────────────
    if (path === '/api/status' && method === 'GET') {
      const target = url.parse(req.url, true).query.target;
      if (!target) { res.writeHead(400); res.end('{}'); return; }

      exec(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 ${target} 'echo "hostname:$(hostname)"; echo "uptime:$(uptime -p)"; bluetoothctl show | grep Powered'`, { timeout: 15000 }, (err, stdout) => {
        if (err) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const lines = stdout.trim().split('\n').reduce((acc, l) => {
          const [k, ...v] = l.split(':');
          acc[k.trim()] = v.join(':').trim();
          return acc;
        }, {});
        res.end(JSON.stringify(lines));
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────┐');
    console.log('  │               🔧 PiBridge  v1.0                         │');
    console.log('  │           BLE Remote GPIO — Single File                 │');
    console.log('  ├──────────────────────────────────────────────────────────┤');
    console.log(`  │  Dashboard:  http://localhost:${PORT.toString().padEnd(5)}                       │`);
    console.log('  │                                                        │');
    console.log('  │  QUICK START (one terminal cmd, then browser-only):    │');
    console.log('  │    sudo node pibridge.mjs --prep-sd /dev/sdX           │');
    console.log('  │    (preps SD card with USB gadget + firmware)          │');
    console.log('  │                                                        │');
    console.log('  │  Then: connect Pi to laptop via USB cable (side port)  │');
    console.log('  │  Wait 30s, open dashboard → click Connect via BLE     │');
    console.log('  │                                                        │');
    console.log('  │  Other:                                                │');
    console.log('  │    node pibridge.mjs --firmware        Print firmware  │');
    console.log('  │    node pibridge.mjs --deploy pi@<ip>  SSH deploy     │');
    console.log('  │                                                        │');
    console.log('  │  No Pi yet? Audio + patterns work standalone in       │');
    console.log('  │  your browser — click Mic On and select Audio pattern │');
    console.log('  └──────────────────────────────────────────────────────────┘');
    console.log('');

    if (SHOULD_OPEN) {
      const cmd = process.platform === 'darwin' ? 'open'
                : process.platform === 'win32' ? 'start' : 'xdg-open';
      try { execSync(`${cmd} http://localhost:${PORT}`); } catch {}
    }
  });
}

/* __DASHBOARD__
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>PiBridge — Remote GPIO Dashboard</title>
<style>
:root{--bg:#0d0d1a;--card:#16162a;--accent:#e94560;--text:#e0e0e0;--dim:#6c6c8a;--green:#2ecc71;--red:#e74c3c;--yellow:#f39c12;--blue:#3498db}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
header{background:var(--card);padding:.75rem 1.5rem;display:flex;align-items:center;gap:1rem;border-bottom:1px solid #222;position:sticky;top:0;z-index:100;flex-wrap:wrap}
header h1{font-size:1.2rem;font-weight:600}
.tag{font-size:.6rem;background:var(--accent);padding:.15rem .5rem;border-radius:1rem;opacity:.8;text-transform:uppercase}
.stat{font-size:.75rem;padding:.2rem .75rem;border-radius:1rem;font-weight:500}
.stat.ok{background:var(--green);color:#fff}
.stat.err{background:var(--red);color:#fff}
.stat.warn{background:var(--yellow);color:#000}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:1rem;padding:1rem}
.card{background:var(--card);border-radius:10px;padding:1rem}
.card h2{font-size:.85rem;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin-bottom:.75rem;display:flex;align-items:center;gap:.5rem;font-weight:600}
.row{display:flex;gap:.5rem;align-items:center;margin:.35rem 0;flex-wrap:wrap}
.row label{font-size:.78rem;color:var(--dim);min-width:3rem}
input,select,button{font-family:inherit;font-size:.8rem}
input[type=number]{background:#0d0d1a;border:1px solid #333;color:#fff;padding:.35rem .5rem;border-radius:5px;width:5rem}
input[type=text]{background:#0d0d1a;border:1px solid #333;color:#fff;padding:.35rem .5rem;border-radius:5px;flex:1}
select{background:#0d0d1a;border:1px solid #333;color:#fff;padding:.35rem .5rem;border-radius:5px;cursor:pointer}
select:focus,input:focus{outline:none;border-color:var(--accent)}
input[type=range]{-webkit-appearance:none;height:4px;background:#333;border-radius:2px}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;background:var(--accent);border-radius:50%;cursor:pointer}
input[type=color]{width:36px;height:36px;border:none;border-radius:50%;cursor:pointer;background:none;padding:0}
input[type=color]::-webkit-color-swatch-wrapper{padding:0}
input[type=color]::-webkit-color-swatch{border:2px solid #333;border-radius:50%}
button{background:var(--accent);color:#fff;border:none;padding:.45rem 1rem;border-radius:6px;cursor:pointer;font-weight:500;transition:opacity .15s;white-space:nowrap}
button:hover{opacity:.85}
button.sm{padding:.3rem .6rem;font-size:.7rem}
button.sec{background:#2c3e50}
button.danger{background:var(--red)}
button:disabled{opacity:.4;cursor:not-allowed}
.val{font-family:"SF Mono","Fira Code",monospace;font-size:.75rem;color:var(--dim);min-width:2.5rem;text-align:right}
.pin-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(48px,1fr));gap:4px;margin-top:.5rem}
.pin{background:#0d0d1a;border-radius:5px;padding:.3rem .1rem;text-align:center;cursor:pointer;font-size:.65rem;transition:.15s;border:1px solid transparent;user-select:none}
.pin:hover{border-color:var(--dim)}.pin .n{font-weight:600;font-size:.85rem;display:block}.pin .l{font-size:.5rem;opacity:.4}
.pin.on{background:#1a3a2a;border-color:var(--green)}.pin.on .n{color:var(--green)}
.pin.off{background:#1a1a2a}.pin.off .n{color:var(--dim)}
.pin.high{background:#1a3a2a;border-color:var(--green)}.pin.low{background:#1a1a2a;border-color:var(--dim)}
canvas.vis{width:100%;height:80px;background:#0a0a15;border-radius:6px;display:block;margin:.4rem 0}
.scene-item{display:flex;align-items:center;gap:.5rem;padding:.4rem .6rem;background:#0d0d1a;border-radius:6px;margin:.3rem 0;font-size:.78rem}
.scene-item .nm{flex:1}.scene-item .meta{font-size:.65rem;color:var(--dim)}
.drop-zone{border:2px dashed #333;padding:.75rem;text-align:center;border-radius:8px;font-size:.78rem;color:var(--dim);cursor:pointer;transition:.2s}
.drop-zone:hover,.drop-zone.drag{border-color:var(--accent);background:rgba(233,69,96,.05)}
.srow{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.bdg{background:#2c3e50;padding:.1rem .45rem;border-radius:3px;font-size:.65rem}
#deployLog{background:#0a0a15;border-radius:6px;padding:.5rem;font-family:"SF Mono",monospace;font-size:.7rem;max-height:200px;overflow-y:auto;margin-top:.5rem;white-space:pre-wrap}
#deployLog .info{color:var(--dim)}#deployLog .ok{color:var(--green)}#deployLog .err{color:var(--red)}
.preview-box{background:#0a0a15;border-radius:6px;padding:.5rem;font-family:"SF Mono",monospace;font-size:.65rem;max-height:150px;overflow-y:auto;white-space:pre-wrap;word-break:break-all;margin-top:.5rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;font-size:.75rem}
dt{color:var(--dim)}dd{font-family:"SF Mono",monospace}
@media(max-width:600px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<header>
  <h1>🔧 PiBridge</h1>
  <span class="tag">BLE GPIO</span>
  <span id="connStatus" class="stat err">Disconnected</span>
  <button id="connectBtn">🔗 Connect</button>
  <span id="deviceInfo" style="font-size:.75rem;color:var(--dim);margin-left:auto"></span>
</header>

<div class="grid">

  <!-- GPIO CONTROL -->
  <div class="card">
    <h2>⚡ GPIO</h2>
    <div class="row">
      <label>Pin:</label><input type="number" id="gpioPin" value="17" min="2" max="27">
      <label>Mode:</label>
      <select id="gpioMode">
        <option value="0">Off</option><option value="1">Input</option>
        <option value="2" selected>Output</option><option value="3">PWM</option>
        <option value="4">Servo</option><option value="5">WS2812</option><option value="6">Analog</option>
      </select>
      <button class="sm sec" id="configBtn">Set</button>
    </div>
    <div class="row">
      <button id="highBtn">HIGH</button>
      <button id="lowBtn">LOW</button>
      <button class="sec" id="toggleBtn">Toggle</button>
      <button class="sec" id="readBtn">Read</button>
      <span id="pinVal" class="val">—</span>
    </div>
    <div class="pin-grid" id="pinGrid"></div>
  </div>

  <!-- LEDS -->
  <div class="card">
    <h2>🌈 LEDs</h2>
    <div class="row">
      <label>Count:</label><input type="number" id="ledCount" value="60" min="1" max="500" style="width:4rem">
      <label>Pin:</label><input type="number" id="ledPin" value="18" min="2" max="27" style="width:3.5rem">
      <button class="sm sec" id="initLeds">Init</button>
    </div>
    <div class="row">
      <label>Pattern:</label>
      <select id="patternSel">
        <option value="0">Off</option><option value="1" selected>Solid</option>
        <option value="2">Rainbow</option><option value="3">Breathe</option>
        <option value="4">Theater</option><option value="5">🎵 Audio Reactive</option>
      </select>
      <input type="color" id="patColor" value="#ff0044">
      <label style="min-width:auto">Speed</label>
      <input type="range" id="patSpeed" min="1" max="255" value="80" style="width:4rem">
      <span id="patSpeedVal" class="val">80</span>
    </div>
    <div class="row">
      <button id="startPat">▶ Start</button>
      <button class="sec" id="stopPat">■ Stop</button>
      <button class="sec" id="sendColorBtn">Send Color</button>
    </div>
  </div>

  <!-- AUDIO REACTIVE -->
  <div class="card">
    <h2>🎵 Audio</h2>
    <div class="row">
      <button id="audioBtn">🎤 Mic On</button>
      <span id="audioLabel" style="font-size:.75rem;color:var(--dim)">Standalone mode (no Pi needed)</span>
    </div>
    <div id="audioPanel" style="display:none">
      <canvas class="vis" id="audioVis"></canvas>
      <div class="srow">
        <span class="bdg" style="background:var(--red)">Bass <span id="bassVal">0</span></span>
        <span class="bdg" style="background:var(--green)">Mid <span id="midVal">0</span></span>
        <span class="bdg" style="background:var(--blue)">Treble <span id="trebleVal">0</span></span>
        <span class="bdg">BPM <span id="bpmVal">—</span></span>
        <span id="beatBadge" class="bdg" style="background:#555">⚡</span>
      </div>
      <div class="row" style="margin-top:.5rem">
        <label>React on:</label>
        <select id="reactTarget">
          <option value="leds">LED Strip (if connected)</option>
          <option value="preview">Browser preview only</option>
        </select>
      </div>
    </div>
  </div>

  <!-- PWM / SERVO -->
  <div class="card">
    <h2>🎛️ PWM / Servo</h2>
    <div class="row">
      <label>Pin:</label><input type="number" id="pwmPin" value="12" min="2" max="27" style="width:3.5rem">
      <label>Duty:</label><input type="range" id="pwmDuty" min="0" max="100" value="0" style="width:5rem">
      <span id="pwmDutyVal" class="val">0%</span>
      <label>Freq:</label><input type="number" id="pwmFreq" value="1000" min="1" max="10000" style="width:4rem">
      <button class="sm sec" id="setPwmBtn">Set PWM</button>
    </div>
    <div class="row">
      <label>Servo:</label>
      <input type="range" id="servoPulse" min="500" max="2500" value="1500" style="width:6rem">
      <span id="servoPulseVal" class="val">1500µs</span>
      <button class="sm sec" id="setServoBtn">Set</button>
    </div>
  </div>

  <!-- ANALOG -->
  <div class="card">
    <h2>📊 Analog (MCP3008)</h2>
    <div class="row">
      <label>Channel:</label>
      <select id="analogChan">
        <option>0</option><option>1</option><option>2</option><option>3</option>
        <option>4</option><option>5</option><option>6</option><option>7</option>
      </select>
      <button class="sm sec" id="cfgAnalogBtn">Config on pin 17</button>
      <button class="sm" id="readAnalogBtn">Read</button>
      <span id="analogVal" class="val">—</span>
    </div>
  </div>

  <!-- SCENES -->
  <div class="card">
    <h2>📋 Scenes</h2>
    <div class="row">
      <input type="text" id="sceneName" placeholder="Scene name...">
      <button class="sm sec" id="saveSceneBtn">💾 Save</button>
    </div>
    <div id="sceneList"><div style="font-size:.78rem;color:var(--dim)">No scenes saved.</div></div>
  </div>

  <!-- PROVISIONING -->
  <div class="card">
    <h2>📦 Provision Pi</h2>
    <div class="row">
      <label>Pi address:</label>
      <input type="text" id="deployTarget" placeholder="pi@192.168.1.42" style="font-family:monospace">
      <button id="deployBtn">📡 Deploy</button>
      <button class="sm sec" id="checkPiBtn">🔍 Check</button>
    </div>
    <div id="deployLog"></div>
    <details style="margin-top:.5rem;font-size:.75rem">
      <summary style="cursor:pointer;color:var(--dim)">View firmware source</summary>
      <div class="preview-box" id="fwPreview">Loading...</div>
      <button class="sm sec" id="dlFwBtn" style="margin-top:.5rem">⬇️ Download pibridge.py</button>
    </details>
  </div>

  <!-- SYSTEM -->
  <div class="card">
    <h2>⚙️ System</h2>
    <div class="row">
      <button class="sm sec" id="statusBtn">🔍 Status</button>
      <button class="sm danger" id="rebootBtn">🔄 Reboot Pi</button>
      <span id="sysInfo" style="font-size:.75rem;color:var(--dim)"></span>
    </div>
    <dl>
      <dt>Dashboard server:</dt><dd><span id="serverUrl">http://localhost:8080</span></dd>
      <dt>BLE service:</dt><dd>4d697272-6f72-0000-0000-000000000000</dd>
      <dt>Pi firmware:</dt><dd>pibridge.py (280 lines, BlueZ D-Bus)</dd>
    </dl>
  </div>

</div>

<script>
// ═══════════════════════════════════════════════════════════════════════════
// PiBridge Dashboard — Full browser client
// ═══════════════════════════════════════════════════════════════════════════

(function(){
'use strict';

// ── BLE Protocol Constants ────────────────────────────────────────────────
const SVC = '4d697272-6f72-0000-0000-000000000000';
const CH = {
  pin_config:'4d697272-6f72-0001-0000-000000000000',
  digital_out:'4d697272-6f72-0002-0000-000000000000',
  digital_in:'4d697272-6f72-0003-0000-000000000000',
  pwm:'4d697272-6f72-0004-0000-000000000000',
  servo:'4d697272-6f72-0005-0000-000000000000',
  analog:'4d697272-6f72-0006-0000-000000000000',
  ws2812_frame:'4d697272-6f72-0007-0000-000000000000',
  ws2812_mode:'4d697272-6f72-0008-0000-000000000000',
  audio:'4d697272-6f72-0009-0000-000000000000',
  system:'4d697272-6f72-000B-0000-000000000000',
};
const ALL_PINS = [2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27];

// ── State ─────────────────────────────────────────────────────────────────
let dev, srv, svc, chs = {}, connected = false;
let gpio = {};  // pin -> 0/1
let scenes = [];
let audioEngine = null, audioActive = false, audioFrameId = null;
let patTick = 0, patRunning = false, patFrameId = null;

// DOM helpers
const $ = id => document.getElementById(id);
const connStatus = $('connStatus'), connectBtn = $('connectBtn'), deviceInfo = $('deviceInfo');

// ── BLE Helper ─────────────────────────────────────────────────────────────
function makeDigitalWriteBuf(mask, vals) {
  const b = new ArrayBuffer(8);
  const v = new DataView(b);
  v.setUint32(0, mask >>> 0, true);
  v.setUint32(4, vals >>> 0, true);
  return b;
}

function writeChar(name, data) {
  if (!chs[name]) return;
  try { chs[name].writeValue(data); } catch (e) { console.warn('BLE write', name, e.message); }
}

// ── Connection ─────────────────────────────────────────────────────────────
connectBtn.onclick = async () => {
  if (connected) {
    if (dev && dev.gatt) dev.gatt.disconnect();
    return;
  }
  try {
    dev = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'PiBridge' }],
      optionalServices: [SVC],
    });
    srv = await dev.gatt.connect();
    svc = await srv.getPrimaryService(SVC);
    for (const [n, u] of Object.entries(CH)) chs[n] = await svc.getCharacteristic(u);
    connected = true;
    connStatus.textContent = 'Connected'; connStatus.className = 'stat ok';
    connectBtn.textContent = '❌ Disconnect';
    deviceInfo.textContent = dev.name || 'PiBridge';

    if (chs.digital_in) {
      await chs.digital_in.startNotifications();
      chs.digital_in.addEventListener('characteristicvaluechanged', e => {
        const a = new Uint8Array(e.target.value.buffer);
        for (let i = 0; i < a.length; i += 2) gpio[a[i]] = a[i + 1];
        renderPinGrid();
      });
    }
    if (chs.system) {
      await chs.system.startNotifications();
      chs.system.addEventListener('characteristicvaluechanged', e => {
        try {
          const st = JSON.parse(new TextDecoder().decode(e.target.value));
          if (st.pins !== undefined) $('sysInfo').textContent = 'Pins: ' + st.pins + ' | Audio: ' + (st.audio?.bpm || 0) + ' BPM';
        } catch {}
      });
    }
    dev.addEventListener('gattserverdisconnected', () => {
      connected = false; connStatus.textContent = 'Disconnected'; connStatus.className = 'stat err';
      connectBtn.textContent = '🔗 Connect'; deviceInfo.textContent = ''; chs = {}; gpio = {}; renderPinGrid();
    });
    renderPinGrid();
    writeChar('system', new Uint8Array([0]));
  } catch (e) {
    connStatus.textContent = 'Error: ' + e.message; connStatus.className = 'stat err';
  }
};

// ── Pin Grid ───────────────────────────────────────────────────────────────
function renderPinGrid() {
  const g = $('pinGrid'); g.innerHTML = '';
  for (const p of ALL_PINS) {
    const v = gpio[p];
    const d = document.createElement('div');
    d.className = 'pin ' + (v === 1 ? 'high' : 'low');
    d.innerHTML = '<span class="n">' + p + '</span><span class="l">' + (v === 1 ? 'HIGH' : v === 0 ? 'LOW' : '—') + '</span>';
    d.onclick = () => togglePin(p);
    g.appendChild(d);
  }
}

async function togglePin(p) {
  if (!connected || !chs.digital_out) return;
  const cur = gpio[p] || 0;
  const mask = 1 << p;
  const vals = cur ? 0 : mask;
  await chs.digital_out.writeValue(makeDigitalWriteBuf(mask, vals));
  gpio[p] = cur ? 0 : 1;
  renderPinGrid();
}

// ── GPIO Panel ─────────────────────────────────────────────────────────────
$('configBtn').onclick = async () => {
  if (!connected) return;
  const pin = parseInt($('gpioPin').value);
  const mode = parseInt($('gpioMode').value);
  let d;
  if (mode === 5) { const c = parseInt($('ledCount').value); d = new Uint8Array([pin, 5, c & 0xFF, (c >> 8) & 0xFF]); }
  else if (mode === 6) { d = new Uint8Array([pin, 6, parseInt($('analogChan').value)]); }
  else d = new Uint8Array([pin, mode]);
  writeChar('pin_config', d);
};

$('highBtn').onclick = () => setPinVal(1);
$('lowBtn').onclick = () => setPinVal(0);
$('toggleBtn').onclick = () => togglePin(parseInt($('gpioPin').value));
$('readBtn').onclick = async () => {
  if (!connected || !chs.digital_in) return;
  try {
    const v = await chs.digital_in.readValue();
    const a = new Uint8Array(v.buffer);
    const pin = parseInt($('gpioPin').value);
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] === pin) { $('pinVal').textContent = a[i+1] ? 'HIGH' : 'LOW'; gpio[pin] = a[i+1]; break; }
    }
    renderPinGrid();
  } catch (e) { $('pinVal').textContent = 'Err'; }
};

async function setPinVal(v) {
  if (!connected) return;
  const pin = parseInt($('gpioPin').value);
  const mask = 1 << pin, vals = v ? mask : 0;
  await chs.digital_out.writeValue(makeDigitalWriteBuf(mask, vals));
  gpio[pin] = v; $('pinVal').textContent = v ? 'HIGH' : 'LOW'; renderPinGrid();
}

// ── LEDs ───────────────────────────────────────────────────────────────────
$('initLeds').onclick = () => {
  if (!connected) return;
  const pin = parseInt($('ledPin').value), count = parseInt($('ledCount').value);
  writeChar('pin_config', new Uint8Array([pin, 5, count & 0xFF, (count >> 8) & 0xFF]));
};

$('patSpeed').oninput = () => { $('patSpeedVal').textContent = $('patSpeed').value; };

$('startPat').onclick = async () => {
  const pid = parseInt($('patternSel').value);
  const c = $('patColor').value;
  const r = parseInt(c.slice(1,3),16), g = parseInt(c.slice(3,5),16), b = parseInt(c.slice(5,7),16);
  const spd = parseInt($('patSpeed').value), pin = parseInt($('ledPin').value);

  if (connected) writeChar('ws2812_mode', new Uint8Array([pin, pid, spd, r, g, b]));

  patRunning = true;
  patTick = 0;
  if (!patFrameId) { (function step() {
    if (!patRunning) { patFrameId = null; return; }
    patTick++; if (patTick > 10000) patTick = 0;
    if (pid === 5 && audioActive) {
      const count = parseInt($('ledCount').value);
      const frame = genPatternFrame(pid, count, { r, g, b, speed: spd, audioState: audioEngine ? audioEngine.state : null }, patTick);
      if (connected) writeChar('ws2812_frame', frame);
    }
    patFrameId = requestAnimationFrame(step);
  })(); }
};

$('stopPat').onclick = () => {
  patRunning = false;
  if (connected) writeChar('ws2812_mode', new Uint8Array([parseInt($('ledPin').value), 0, 0, 0, 0, 0]));
};
$('sendColorBtn').onclick = () => {
  if (!connected) return;
  const c = $('patColor').value;
  const r = parseInt(c.slice(1,3),16), g = parseInt(c.slice(3,5),16), b = parseInt(c.slice(5,7),16);
  const count = parseInt($('ledCount').value);
  const f = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) { f[i*3]=r; f[i*3+1]=g; f[i*3+2]=b; }
  writeChar('ws2812_frame', f);
};

function genPatternFrame(id, count, p, tick) {
  const f = new Uint8Array(count * 3);
  const { r=255, g=0, b=0, speed=80, audioState } = p;
  const s = speed / 255;
  if (id === 0) { f.fill(0); return f; }
  if (id === 1) { for (let i = 0; i < count; i++) { f[i*3]=r; f[i*3+1]=g; f[i*3+2]=b; } return f; }
  if (id === 2) {
    for (let i = 0; i < count; i++) {
      const hue = ((i / count) + tick * s * 0.01) % 1.0;
      const [cr, cg, cb] = hsv(hue, 1, 1);
      f[i*3]=cr; f[i*3+1]=cg; f[i*3+2]=cb;
    } return f;
  }
  if (id === 3) {
    const br = Math.sin(tick * s * 0.05) * 0.5 + 0.5;
    for (let i = 0; i < count; i++) { f[i*3]=Math.round(r*br); f[i*3+1]=Math.round(g*br); f[i*3+2]=Math.round(b*br); }
    return f;
  }
  if (id === 4) {
    for (let i = 0; i < count; i++) { if (i % 3 === (tick % 3)) { f[i*3]=r; f[i*3+1]=g; f[i*3+2]=b; } }
    return f;
  }
  if (id === 5 && audioState) {
    const { bass, mid, treble, beat } = audioState;
    const bs = bass / 255, ms = mid / 255, ts = treble / 255;
    for (let i = 0; i < count; i++) {
      const pct = i / count;
      if (pct < 1/3) { f[i*3]=Math.round(bs*255); f[i*3+1]=0; f[i*3+2]=0; }
      else if (pct < 2/3) { f[i*3]=0; f[i*3+1]=Math.round(ms*255); f[i*3+2]=0; }
      else { f[i*3]=0; f[i*3+1]=0; f[i*3+2]=Math.round(ts*255); }
    }
    if (beat) for (let i = 0; i < count; i++) {
      f[i*3] = Math.min(255, f[i*3] + 200);
      f[i*3+1] = Math.min(255, f[i*3+1] + 200);
      f[i*3+2] = Math.min(255, f[i*3+2] + 200);
    }
    return f;
  }
  f.fill(0); return f;
}

function hsv(h, s, v) {
  const i = Math.floor(h*6), f = h*6-i, p = v*(1-s), q = v*(1-f*s), t = v*(1-(1-f)*s);
  return [[v,t,p],[q,v,p],[p,v,t],[p,q,v],[t,p,v],[v,p,q]][i%6].map(x => Math.round(x*255));
}

// ── Audio Reactive ─────────────────────────────────────────────────────────
$('audioBtn').onclick = async () => {
  if (audioActive) {
    audioActive = false;
    if (audioEngine) { audioEngine.stop(); audioEngine = null; }
    $('audioPanel').style.display = 'none';
    $('audioLabel').textContent = 'Standalone mode (no Pi needed)';
    $('audioBtn').textContent = '🎤 Mic On';
    if (audioFrameId) { cancelAnimationFrame(audioFrameId); audioFrameId = null; }
    return;
  }

  audioEngine = new AudioEngine();
  const ok = await audioEngine.start();
  if (!ok) { $('audioLabel').textContent = '❌ Mic access denied'; return; }

  audioActive = true;
  $('audioLabel').textContent = '🔴 Listening — audio reactive works standalone!';
  $('audioBtn').textContent = '⏹ Stop';
  $('audioPanel').style.display = 'block';

  if (parseInt($('patternSel').value) === 5) {
    patRunning = true;
    $('startPat').click();
  }

  (function loop() {
    if (!audioActive || !audioEngine) { audioFrameId = null; return; }
    const st = audioEngine.process();
    if (st) {
      $('bassVal').textContent = st.bass;
      $('midVal').textContent = st.mid;
      $('trebleVal').textContent = st.treble;
      $('bpmVal').textContent = st.bpm || '—';
      const be = $('beatBadge');
      if (st.beat) {
        be.style.background = '#e94560'; be.textContent = '⚡ BEAT';
        setTimeout(() => { be.style.background = '#555'; be.textContent = '⚡'; }, 150);
      }
      if (connected && chs.audio) writeChar('audio', audioEngine.pack());
    }
    drawAudioVis();
    audioFrameId = requestAnimationFrame(loop);
  })();
};

function drawAudioVis() {
  const c = $('audioVis');
  if (!c || !audioEngine || !audioEngine.data) return;
  const ctx = c.getContext('2d'), w = c.width, h = c.height;
  ctx.clearRect(0, 0, w, h);
  const d = audioEngine.data, bw = w / d.length;
  for (let i = 0; i < d.length; i++) {
    const bh = (d[i] / 255) * h;
    ctx.fillStyle = 'hsl(' + ((i * 3) % 360) + ', 80%, 60%)';
    ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
  }
}

// Minimal AudioEngine for browser (replicating export)
class AudioEngine {
  constructor() { this.ctx=null; this.analyser=null; this.source=null; this.data=null;
    this.history=[]; this.lastBeat=0; this.bass=0; this.mid=0; this.treble=0; this.bpm=0; this.beat=false; }
  async start() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({audio: true});
      this.ctx = new AudioContext(); this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.source = this.ctx.createMediaStreamSource(s);
      this.source.connect(this.analyser);
      this.data = new Uint8Array(this.analyser.frequencyBinCount);
      return true;
    } catch(e) { return false; }
  }
  stop() { if(this.ctx)this.ctx.close(); this.analyser=null; this.data=null; this.history=[]; }
  process() {
    if(!this.analyser||!this.data)return null;
    this.analyser.getByteFrequencyData(this.data);
    this.bass = this._avg(0,4); this.mid = this._avg(4,12); this.treble = this._avg(12,32);
    const total = this.bass+this.mid+this.treble;
    this.history.push(total); if(this.history.length>30)this.history.shift();
    const avg = this.history.reduce((a,b)=>a+b,0)/this.history.length;
    this.beat = this.history.length>10 && total>avg*1.3;
    const now=performance.now(); if(this.beat){const dt=now-this.lastBeat;if(dt>200&&dt<2000)this.bpm=Math.round(60000/dt);this.lastBeat=now;}
    return this.state;
  }
  get state() { return {bass:Math.round(this.bass),mid:Math.round(this.mid),treble:Math.round(this.treble),bpm:this.bpm,beat:this.beat}; }
  pack() { const b=new Uint8Array(6); b[0]=Math.round(this.bass); b[1]=Math.round(this.mid); b[2]=Math.round(this.treble);
    b[3]=this.bpm&0xFF; b[4]=(this.bpm>>8)&0xFF; b[5]=this.beat?1:0; return b; }
  _avg(s,e){let sum=0;for(let i=s;i<e;i++)sum+=this.data[i];return sum/(e-s);}
}
window.AudioEngine = AudioEngine; // expose for console

// ── PWM / Servo ────────────────────────────────────────────────────────────
$('pwmDuty').oninput = () => { $('pwmDutyVal').textContent = $('pwmDuty').value + '%'; };
$('servoPulse').oninput = () => { $('servoPulseVal').textContent = $('servoPulse').value + 'µs'; };
$('setPwmBtn').onclick = () => {
  if (!connected) return;
  const pin = parseInt($('pwmPin').value), duty = parseInt($('pwmDuty').value), freq = parseInt($('pwmFreq').value);
  const b = new Uint8Array(5); b[0]=pin; b[1]=duty; b[2]=freq&0xFF; b[3]=(freq>>8)&0xFF;
  writeChar('pwm', b);
};
$('setServoBtn').onclick = () => {
  if (!connected) return;
  const pin = parseInt($('pwmPin').value), pulse = parseInt($('servoPulse').value);
  const b = new Uint8Array(3); b[0]=pin; b[1]=pulse&0xFF; b[2]=(pulse>>8)&0xFF;
  writeChar('servo', b);
};

// ── Analog ─────────────────────────────────────────────────────────────────
$('cfgAnalogBtn').onclick = () => {
  if (!connected) return;
  writeChar('pin_config', new Uint8Array([parseInt($('gpioPin').value), 6, parseInt($('analogChan').value)]));
};
$('readAnalogBtn').onclick = async () => {
  if (!connected || !chs.analog) return;
  try {
    const v = await chs.analog.readValue();
    const a = new Uint8Array(v.buffer);
    for (let i = 0; i < a.length; i += 3) {
      const pin = a[i], val = (a[i+2] << 8) | a[i+1];
      $('analogVal').textContent = 'Pin ' + pin + ': ' + val + ' (' + (val/1023*100).toFixed(1) + '%)';
    }
  } catch(e) { $('analogVal').textContent = 'Err'; }
};

// ── Scenes ─────────────────────────────────────────────────────────────────
function loadScenes() { try { scenes = JSON.parse(localStorage.getItem('pibridge_scenes') || '[]'); } catch { scenes = []; } renderScenes(); }
function saveScenes() { localStorage.setItem('pibridge_scenes', JSON.stringify(scenes)); renderScenes(); }
function renderScenes() {
  const l = $('sceneList'); l.innerHTML = '';
  if (!scenes.length) { l.innerHTML = '<div style="font-size:.78rem;color:var(--dim)">No scenes saved. Configure pins and save one!</div>'; return; }
  for (const s of scenes) {
    const d = document.createElement('div'); d.className = 'scene-item';
    d.innerHTML = '<span>📋</span><span class="nm">' + s.name + '</span><span class="meta">' + (s.pins || Object.keys(s.state||{}).length) + ' pins</span>' +
      '<button class="sm sec" data-load="' + s.name + '">▶</button>' +
      '<button class="sm danger" data-del="' + s.name + '">✕</button>';
    d.querySelector('[data-load]').onclick = () => applyScene(s);
    d.querySelector('[data-del]').onclick = () => { scenes = scenes.filter(x => x.name !== s.name); saveScenes(); };
    l.appendChild(d);
  }
}
$('saveSceneBtn').onclick = () => {
  const name = $('sceneName').value.trim(); if (!name) return;
  const state = {}; for (const p of ALL_PINS) { if (gpio[p] !== undefined) state[p] = gpio[p]; }
  scenes.push({ name, pins: Object.keys(state).length, state, savedAt: Date.now() });
  $('sceneName').value = ''; saveScenes();
};
async function applyScene(s) {
  if (!connected || !chs.digital_out || !s.state) return;
  const entries = Object.entries(s.state);
  for (let i = 0; i < entries.length; i += 8) {
    let mask = 0, vals = 0;
    for (const [pin, val] of entries.slice(i, i+8)) { const b = 1 << parseInt(pin); mask |= b; if (val) vals |= b; }
    await chs.digital_out.writeValue(makeDigitalWriteBuf(mask, vals));
  }
  for (const [pin, val] of entries) gpio[parseInt(pin)] = val;
  renderPinGrid();
}
loadScenes();

// ── Provisioning ───────────────────────────────────────────────────────────
$('dlFwBtn').onclick = () => { const a = document.createElement('a'); a.href = '/pibridge.py'; a.download = 'pibridge.py'; a.click(); };

// Load firmware preview
fetch('/pibridge.py').then(r => r.text()).then(code => {
  $('fwPreview').textContent = code.slice(0, 800) + '\n\n... (full file: ' + code.length + ' chars)';
});

$('deployBtn').onclick = () => {
  const target = $('deployTarget').value.trim();
  if (!target) { $('deployLog').innerHTML = '<span class="err">Enter target address (e.g. pi@192.168.1.42)</span>'; return; }

  const log = $('deployLog');
  log.innerHTML = '<span class="info">⏳ Deploying to ' + target + '...</span>';
  $('deployBtn').disabled = true;

  const evtSource = new EventSourcePolyfill('/api/deploy', {
    method: 'POST',
    body: JSON.stringify({ target }),
    headers: { 'Content-Type': 'application/json' },
  });

  // Use fetch with streaming for SSE-like output
  fetch('/api/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target }),
  }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Parse SSE events
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const evtType = line.slice(7);
          // next line is data
        } else if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6));
            const cls = d.error ? 'err' : d.message?.includes('✅') || d.message?.includes('🎉') ? 'ok' : 'info';
            log.innerHTML += '\n<span class="' + cls + '">' + (d.message || '') + '</span>';
            log.scrollTop = log.scrollHeight;
          } catch {}
        }
      }
    }
    log.innerHTML += '\n<span class="ok">✅ Done</span>';
    $('deployBtn').disabled = false;
  }).catch(err => {
    log.innerHTML += '\n<span class="err">❌ ' + err.message + '</span>';
    $('deployBtn').disabled = false;
  });
};

$('checkPiBtn').onclick = () => {
  const target = $('deployTarget').value.trim();
  if (!target) return;
  fetch('/api/status?target=' + encodeURIComponent(target))
    .then(r => r.json())
    .then(data => {
      const log = $('deployLog');
      if (data.error) log.innerHTML = '<span class="err">❌ ' + data.error + '</span>';
      else log.innerHTML = '<span class="ok">✅ ' + (data.hostname || 'Pi') + ' — ' + (data.uptime || '') + '</span>';
    });
};

// ── System ─────────────────────────────────────────────────────────────────
$('statusBtn').onclick = () => { if (connected) writeChar('system', new Uint8Array([0])); };
$('rebootBtn').onclick = () => { if (connected && confirm('Reboot Pi?')) writeChar('system', new Uint8Array([1])); };

$('serverUrl').textContent = window.location.origin;

// ── Init ───────────────────────────────────────────────────────────────────
renderPinGrid();
console.log('🔧 PiBridge Dashboard loaded');
console.log('📡 No Pi? Audio + patterns work standalone in browser!');
console.log('   Click "Mic On" and select "🎵 Audio Reactive" pattern');
})();
</script>
</body>
</html>
__DASHBOARD__ */
