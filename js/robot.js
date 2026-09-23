// Web Bluetooth connection to the robot — the browser counterpart of TableBot's RobotManager.kt.
// Emits 'change' whenever anything the UI shows changes, and 'log' for each diagnostic line.

import * as P from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE_TIMEOUT_MS = 3000;
const KEEPALIVE_MS = 5000;
const MAX_RETRIES = 3;
const RETRY_SETTLE_MS = 1000;

export class Robot extends EventTarget {
  constructor(settings) {
    super();
    this.settings = settings; // { chunk, settleMs, robotType } — read live, so edits apply on the next write
    this.device = null;
    this.writeChar = null;
    this.notifyChars = [];
    this.assemblers = new WeakMap();
    this.deviceId = P.ZERO_ID;

    this.state = 'disconnected'; // disconnected | connecting | connected
    this.status = '';
    this.firmware = null;
    this.verified = false;
    this.playing = false;

    this.writeQueue = Promise.resolve();
    this.playToken = 0; // bumped by stop(); a play sequence aborts when it no longer matches
    this.keepaliveTimer = null;
    this.firmwareProbe = null;
    this.framesSinceConnect = 0;
    this.retries = 0;
    this.userDisconnect = false;
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  // ── Connection ─────────────────────────────────────────────────────────

  /** Must be called from a tap: the browser only shows the device picker in response to one. */
  async connect() {
    if (!Robot.supported) throw new Error('This browser has no Web Bluetooth. On iPhone, open the page in Bluefy.');
    this.set({ state: 'connecting', status: 'Choose the robot (J-…)…' });
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'J-' }],
        optionalServices: [P.SERVICE_UUID, P.ALT_SERVICE_UUID],
      });
    } catch (e) {
      this.set({ state: 'disconnected', status: e.name === 'NotFoundError' ? 'No robot chosen' : e.message });
      return;
    }
    if (this.device && this.device !== device) this.device.removeEventListener('gattserverdisconnected', this.onDrop);
    this.device = device;
    this.device.addEventListener('gattserverdisconnected', this.onDrop);
    this.retries = 0;
    this.userDisconnect = false;
    await this.open(false);
  }

  /** Reconnects to the robot picked earlier, without showing the picker again. */
  async reconnect() {
    if (!this.device) return this.connect();
    this.retries = 0;
    this.userDisconnect = false;
    await this.open(false);
  }

  async open(isRetry) {
    const name = this.device.name ?? '';
    this.deviceId = P.deviceIdFromName(name);
    this.framesSinceConnect = 0;
    this.set({ state: 'connecting', status: `Connecting to ${name}…`, verified: false, firmware: null });
    this.log(`connect ${name} id=${this.deviceId} chunk=${this.settings.chunk} settle=${this.settings.settleMs}ms${isRetry ? ' (retry)' : ''}`);

    try {
      const server = await this.device.gatt.connect();

      // The robot has been seen going deaf right after the connection-parameter change that
      // follows discovery on Android; the app waits before discovering, and so do we.
      const settle = isRetry ? Math.max(this.settings.settleMs, RETRY_SETTLE_MS) : this.settings.settleMs;
      if (settle > 0) {
        this.set({ status: 'Settling link…' });
        await sleep(settle);
      }

      this.set({ status: 'Discovering services…' });
      await this.pickCharacteristics(server);

      for (const ch of this.notifyChars) {
        // Browsers may hand back the same characteristic object after a reconnect, so attach the
        // listener once and just clear its buffer: a link that died mid-notification leaves a
        // partial frame behind that would otherwise corrupt the next connection's first reply.
        let assembler = this.assemblers.get(ch);
        if (assembler) {
          assembler.reset();
        } else {
          assembler = new P.FrameAssembler();
          this.assemblers.set(ch, assembler);
          ch.addEventListener('characteristicvaluechanged', (ev) => {
            const v = ev.target.value;
            const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            for (const f of assembler.push(bytes)) this.onFrame(f);
          });
        }
        await ch.startNotifications();
        this.log(`notifications on ${short(ch.uuid)}`);
        await sleep(300);
      }

      this.set({ status: 'Sending handshake…' });
      await this.send(P.buildConnectFrame(this.deviceId));
      await sleep(200);

      // CONNECT has no reply. The version query (0x05 -> 0x85) does, and tells a live link from a
      // dead one. Firmware v01.14 was confirmed to answer it on the bench.
      this.set({ status: 'Verifying link…' });
      const probe = new Promise((resolve) => { this.firmwareProbe = resolve; });
      await this.send(P.buildVersionQueryFrame(this.deviceId));
      const fw = await Promise.race([probe, sleep(PROBE_TIMEOUT_MS).then(() => null)]);
      this.firmwareProbe = null;

      if (fw || this.framesSinceConnect > 0) {
        this.retries = 0;
        this.set({ state: 'connected', verified: true, status: `Connected to ${name}` });
        this.log(`link verified${fw ? `, firmware ${fw}` : ''}`);
      } else if (this.retries < MAX_RETRIES) {
        this.log('no reply to the version query — dropping and retrying');
        this.set({ status: 'Robot not responding, retrying…' });
        this.device.gatt.disconnect(); // onDrop schedules the retry
      } else {
        // Out of retries. Unlike the Android app, leave the link up: the robot has been seen to
        // answer intermittently while still accepting writes, so let the player try a drill.
        this.set({ state: 'connected', verified: false, status: `Connected (unverified) to ${name}` });
        this.log('still no reply after retries — connected unverified');
      }
    } catch (e) {
      this.log(`connect failed: ${e.message}`);
      this.set({ status: `Connect failed: ${e.message}` });
      if (this.device.gatt.connected) {
        this.device.gatt.disconnect(); // onDrop takes it from here, including the retry
      } else {
        this.set({ state: 'disconnected' });
      }
    }
  }

  async pickCharacteristics(server) {
    this.writeChar = null;
    this.notifyChars = [];

    try {
      const svc = await server.getPrimaryService(P.SERVICE_UUID);
      const ch = await svc.getCharacteristic(P.CHAR_UUID);
      this.writeChar = ch;
      this.notifyChars = [ch];
      this.log('using primary service ffe0');
      return;
    } catch { /* not present on every robot — fall through to the alt service */ }

    const svc = await server.getPrimaryService(P.ALT_SERVICE_UUID);
    const chars = await svc.getCharacteristics();
    const writable = chars.filter((c) => c.properties.write || c.properties.writeWithoutResponse);
    this.writeChar = chars.find((c) => c.uuid === P.ALT_CHAR_WRITE) ?? writable[0] ?? null;
    // Enable every notify/indicate characteristic, as the Android app does (fec8 and fed6).
    this.notifyChars = chars.filter((c) => c.properties.notify || c.properties.indicate);
    this.log(`using alt service fee7: ${chars.map((c) => short(c.uuid)).join(' ')}`);
    if (!this.writeChar) throw new Error('No writable characteristic found');
  }

  onDrop = () => {
    const wasPlaying = this.playing;
    this.cancelDrill();
    this.writeChar = null;
    this.notifyChars = [];
    this.firmwareProbe?.(null);
    this.firmwareProbe = null;
    this.log(`link dropped${wasPlaying ? ' during a drill' : ''}`);

    if (!this.userDisconnect && this.retries < MAX_RETRIES && this.device) {
      this.retries++;
      const wait = 1000 * 2 ** (this.retries - 1);
      this.set({ state: 'connecting', verified: false, status: `Lost connection, retrying in ${wait / 1000}s (${this.retries}/${MAX_RETRIES})…` });
      setTimeout(() => {
        if (!this.userDisconnect && !this.device.gatt.connected) this.open(true);
      }, wait);
    } else {
      this.set({ state: 'disconnected', verified: false, firmware: null, status: this.userDisconnect ? 'Disconnected' : 'Robot not responding' });
    }
  };

  async disconnect() {
    this.userDisconnect = true;
    this.cancelDrill();
    if (this.device?.gatt.connected) {
      try {
        await this.send(P.buildDisconnectFrame(this.deviceId));
        await sleep(200);
      } catch { /* going away anyway */ }
      this.device.gatt.disconnect();
    } else {
      this.set({ state: 'disconnected', status: 'Disconnected' });
    }
  }

  // ── Writing ────────────────────────────────────────────────────────────

  /** Writes are serialised: Web Bluetooth rejects a write while another is in flight. */
  send(frame) {
    const run = this.writeQueue.then(() => this.writeFrame(frame));
    this.writeQueue = run.catch(() => {});
    return run;
  }

  async writeFrame(frame) {
    const ch = this.writeChar;
    if (!ch) throw new Error('Not connected');
    this.log(`→ ${P.toHex(frame)}`);
    for (const chunk of P.splitIntoChunks(frame, this.settings.chunk)) {
      // The protocol calls for ATT Write Command (without response).
      if (ch.properties.writeWithoutResponse && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(chunk);
      else if (ch.writeValueWithResponse) await ch.writeValueWithResponse(chunk);
      else await ch.writeValue(chunk);
      await sleep(30);
    }
  }

  // ── Drills ─────────────────────────────────────────────────────────────

  /** STOP → PRE_PATTERN → PATTERN, then a keepalive every 5 s, as the Android app does. */
  async play(payload) {
    if (this.state !== 'connected') throw new Error('Not connected');
    const token = ++this.playToken;
    clearInterval(this.keepaliveTimer);
    this.set({ playing: true, status: 'Starting drill…' });

    await this.send(P.buildStopFrame(this.deviceId, this.settings.robotType));
    await sleep(500);
    if (token !== this.playToken) return;

    await this.send(P.buildPrePatternFrame(this.deviceId));
    await sleep(500);
    if (token !== this.playToken) return; // stopped while preparing: never send the pattern

    await this.send(P.buildPatternFrame(this.deviceId, payload));
    this.set({ status: 'Playing…' });

    this.keepaliveTimer = setInterval(() => {
      if (this.playing) this.send(P.buildPrePatternFrame(this.deviceId)).catch(() => {});
    }, KEEPALIVE_MS);
  }

  /**
   * 0x03 is the only command that halts a firing drill. No CONNECT afterwards — re-handshaking
   * right after a stop can re-arm the pattern.
   */
  async stop() {
    this.cancelDrill();
    this.set({ status: 'Stopping…' });
    await this.send(P.buildPostPatternFrame(this.deviceId));
    this.set({ status: `Connected to ${this.device?.name ?? 'robot'}` });
  }

  cancelDrill() {
    this.playToken++;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    if (this.playing) this.set({ playing: false });
  }

  async finishDrill() {
    this.cancelDrill();
    this.set({ status: 'Cleaning up…' });
    await this.send(P.buildPostPatternFrame(this.deviceId));
    await sleep(1000);
    await this.send(P.buildConnectFrame(this.deviceId));
    this.set({ status: `Connected to ${this.device?.name ?? 'robot'}` });
    this.dispatchEvent(new Event('done'));
  }

  // ── Receiving ──────────────────────────────────────────────────────────

  onFrame(frame) {
    this.framesSinceConnect++;
    this.log(`← ${P.toHex(frame)}`);
    const r = P.parseFrame(frame);
    if (!r) return;

    if (r.deviceId !== P.ZERO_ID && r.deviceId !== this.deviceId.toLowerCase()) {
      this.log(`device id updated from reply: ${r.deviceId}`);
      this.deviceId = r.deviceId;
    }

    switch (r.cmd) {
      case P.RESP_FIRMWARE:
        this.set({ firmware: r.firmwareVersion });
        this.firmwareProbe?.(r.firmwareVersion);
        break;
      case P.RESP_PATTERN_DONE:
      case P.RESP_STOPPED:
        // Replies arrive on two characteristics, so the second copy finds playing already false.
        if (this.playing) {
          this.log('robot reports drill complete');
          this.finishDrill().catch((e) => this.log(`cleanup failed: ${e.message}`));
        }
        break;
      default:
        break;
    }
  }

  // ── Plumbing ───────────────────────────────────────────────────────────

  set(patch) {
    Object.assign(this, patch);
    this.dispatchEvent(new Event('change'));
  }

  log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    this.dispatchEvent(new CustomEvent('log', { detail: `[${t}] ${msg}` }));
  }
}

const short = (uuid) => uuid.slice(4, 8);
