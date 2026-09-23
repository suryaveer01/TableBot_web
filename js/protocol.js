// Joola Infinity BLE protocol — a straight port of TableBot's RobotProtocol.kt / PlayResolver.kt.
// Pure functions only (no Bluetooth, no DOM) so it can be tested in isolation: see test/.
// The authoritative description of every byte is table_tennis_robot_app/PROTOCOL.md.

export const SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const CHAR_UUID = '0000ffe1-0000-1000-8000-00805f9b34fb';
export const ALT_SERVICE_UUID = '0000fee7-0000-1000-8000-00805f9b34fb';
export const ALT_CHAR_WRITE = '0000fec7-0000-1000-8000-00805f9b34fb';
export const ALT_CHAR_NOTIFY = '0000fec8-0000-1000-8000-00805f9b34fb';

const FRAME_START = 0x68;
const FRAME_END = 0x16;
const FRAME_FIXED = 0x01;

export const CMD_CONNECT = 0x89;
export const CMD_DISCONNECT = 0x99;
export const CMD_PATTERN = 0x01;
export const CMD_STOP = 0x05;          // idle stop (V2) / version query — ignored while a drill fires
export const CMD_STOP_LEGACY = 0x99;   // idle stop on V1 — same opcode as DISCONNECT, intentional
export const CMD_PRE_PATTERN = 0x04;
export const CMD_POST_PATTERN = 0x03;  // the only command that halts a firing drill

export const RESP_PATTERN_ACK = 0x81;
export const RESP_STOPPED = 0x82;
export const RESP_POST_ACK = 0x83;
export const RESP_PRE_ACK = 0x84;
export const RESP_FIRMWARE = 0x85;
export const RESP_PATTERN_DONE = 0x8f;

// Same default as the Android app. Bench testing showed chunk size does not decide whether the
// robot answers, so it is a setting rather than a constant — see RobotProtocol.BLE_MTU.
export const DEFAULT_CHUNK = 10;
export const MAX_REPS = 255;
export const ZERO_ID = '0000000000000000';

// CRC-CCITT lookup table (polynomial 0x1021, init 0x0000), from the original APK.
const CRC_TABLE = [
  0, 4129, 8258, 12387, 16516, 20645, 24774, 28903, 33032, 37161, 41290, 45419, 49548, 53677, 57806, 61935,
  4657, 528, 12915, 8786, 21173, 17044, 29431, 25302, 37689, 33560, 45947, 41818, 54205, 50076, 62463, 58334,
  9314, 13379, 1056, 5121, 25830, 29895, 17572, 21637, 42346, 46411, 34088, 38153, 58862, 62927, 50604, 54669,
  13907, 9842, 5649, 1584, 30423, 26358, 22165, 18100, 46939, 42874, 38681, 34616, 63455, 59390, 55197, 51132,
  18628, 22757, 26758, 30887, 2112, 6241, 10242, 14371, 51660, 55789, 59790, 63919, 35144, 39273, 43274, 47403,
  23285, 19156, 31415, 27286, 6769, 2640, 14899, 10770, 56317, 52188, 64447, 60318, 39801, 35672, 47931, 43802,
  27814, 31879, 19684, 23749, 11298, 15363, 3168, 7233, 60846, 64911, 52716, 56781, 44330, 48395, 36200, 40265,
  32407, 28342, 24277, 20212, 15891, 11826, 7761, 3696, 65439, 61374, 57309, 53244, 48923, 44858, 40793, 36728,
  37256, 33193, 45514, 41451, 53516, 49453, 61774, 57711, 4224, 161, 12482, 8419, 20484, 16421, 28742, 24679,
  33721, 37784, 41979, 46042, 49981, 54044, 58239, 62302, 689, 4752, 8947, 13010, 16949, 21012, 25207, 29270,
  46570, 42443, 38312, 34185, 62830, 58703, 54572, 50445, 13538, 9411, 5280, 1153, 29798, 25671, 21540, 17413,
  42971, 47098, 34713, 38840, 59231, 63358, 50973, 55100, 9939, 14066, 1681, 5808, 26199, 30326, 17941, 22068,
  55628, 51565, 63758, 59695, 39368, 35305, 47498, 43435, 22596, 18533, 30726, 26663, 6336, 2273, 14466, 10403,
  52093, 56156, 60223, 64286, 35833, 39896, 43963, 48026, 19061, 23124, 27191, 31254, 2801, 6864, 10931, 14994,
  64814, 60687, 56684, 52557, 48554, 44427, 40424, 36297, 31782, 27655, 23652, 19525, 15522, 11395, 7392, 3265,
  61215, 65342, 53085, 57212, 44955, 49082, 36825, 40952, 28183, 32310, 20053, 24180, 11923, 16050, 3793, 7920,
];

export function crcCCITT(data, offset = 0, length = data.length) {
  let crc = 0;
  for (let i = offset; i < offset + length; i++) {
    crc = (CRC_TABLE[((crc >> 8) ^ data[i]) & 0xff] ^ (crc << 8)) & 0xffff;
  }
  return crc;
}

function hexToBytes(hex) {
  const padded = hex.padEnd(16, '0').slice(0, 16);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    const b = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error(`invalid device id: ${hex}`);
    out[i] = b;
  }
  return out;
}

const isHex16 = (s) => /^[0-9a-fA-F]{16}$/.test(s);

/**
 * Device ID from the advertised name "J-XXXXXXXXXXXXXXXX". The Android app falls back to the MAC
 * address; Web Bluetooth never exposes it, so the fallback here is all zeros (which the Android
 * app also uses when the id cannot be encoded). The robot's own reply corrects it either way.
 */
export function deviceIdFromName(name) {
  if (!name || !name.startsWith('J-')) return ZERO_ID;
  const suffix = name.slice(2).padEnd(16, '0').slice(0, 16);
  return isHex16(suffix) ? suffix : ZERO_ID;
}

export function buildFrame(deviceId, cmd, payload = []) {
  const dev = hexToBytes(deviceId);
  const len = payload.length;
  const frame = new Uint8Array(14 + len + 3);
  let i = 0;
  frame[i++] = FRAME_START;
  frame[i++] = FRAME_FIXED;
  frame.set(dev, i); i += 8;
  frame[i++] = FRAME_START;
  frame[i++] = cmd;
  frame[i++] = (len >> 8) & 0xff;
  frame[i++] = len & 0xff;
  frame.set(payload, i); i += len;
  const crc = crcCCITT(frame, 0, i);
  frame[i++] = (crc >> 8) & 0xff;
  frame[i++] = crc & 0xff;
  frame[i++] = FRAME_END;
  return frame;
}

export const buildConnectFrame = (id) => buildFrame(id, CMD_CONNECT, [0]);
export const buildVersionQueryFrame = (id) => buildFrame(id, CMD_STOP, []);
export const buildDisconnectFrame = (id) => buildFrame(id, CMD_DISCONNECT, [0]);
export const buildPrePatternFrame = (id) => buildFrame(id, CMD_PRE_PATTERN, [0x02]);
export const buildPostPatternFrame = (id) => buildFrame(id, CMD_POST_PATTERN, [0x00]);
export const buildPatternFrame = (id, payload) => buildFrame(id, CMD_PATTERN, payload);

// Stops a pattern only when the robot is IDLE. Use buildPostPatternFrame to stop a running drill.
export function buildStopFrame(id, robotType = 'V2') {
  return buildFrame(id, robotType === 'V1' ? CMD_STOP_LEGACY : CMD_STOP, [0]);
}

function writePoint(buf, off, params, f) {
  buf[off + 0] = params?.m1speed ?? 0;
  buf[off + 1] = params?.m2speed ?? 0;
  buf[off + 2] = params?.xaxis ?? 0;
  buf[off + 3] = params?.yaxis ?? 0;
  buf[off + 4] = params?.zaxis ?? 0;
  buf[off + 5] = 0;                  // repeatDelay high byte
  buf[off + 6] = f.repeatDelay & 0xff;
  buf[off + 7] = f.b7;
  buf[off + 8] = f.ballTime & 0xff;
  buf[off + 9] = f.groupSize;
  buf[off + 10] = f.targetMode;
  buf[off + 11] = f.orderRandom;
}

function writeTrailer(buf, off, reps) {
  buf[off] = reps & 0xff;
  buf[off + 1] = 1;
  buf[off + 2] = 0;
  buf[off + 3] = 0;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function encodeSingleBall(params, ballTime = 15) {
  const buf = new Uint8Array(16);
  writePoint(buf, 0, params, { repeatDelay: 1, b7: 0, ballTime, groupSize: 1, targetMode: 0, orderRandom: 0 });
  writeTrailer(buf, 12, 1);
  return buf;
}

/** landType 2 (random) sets the firmware's whole-drill random path: b7=0x80, b10=2, b11=1. */
export function encodeBasicPattern(drill, lookup, { times, ballTime } = {}) {
  const isRandom = drill.landType === 2;
  const bt = ballTime ?? drill.ballTime;
  const reps = times ?? drill.times;
  const points = drill.points;
  const buf = new Uint8Array(points.length * 12 + 4);
  points.forEach((p, idx) => {
    writePoint(buf, idx * 12, lookup(drill.ball, drill.spin, drill.power, p.x), {
      repeatDelay: 1,
      b7: isRandom ? 0x80 : 0,
      ballTime: bt,
      groupSize: 1,
      targetMode: isRandom ? 2 : 0,
      orderRandom: isRandom ? 1 : 0,
    });
  });
  writeTrailer(buf, points.length * 12, clamp(reps, 1, MAX_REPS));
  return buf;
}

/**
 * Each step becomes a contiguous group of points (b9 = group size, at most 5). A group of more
 * than one position fires a random one of them (b10=1 on the leader); order-random (b7/b11) is an
 * independent per-step switch. Duplicate positions are emitted as duplicate points (weighting).
 */
export function encodeAdvancedPattern(training, lookup, { repeatNum, repeatDelay } = {}) {
  const reps = repeatNum ?? training.repeatNum;
  const rd = Math.max(1, repeatDelay ?? training.repeatDelay);
  const points = [];
  for (const step of training.steps) {
    for (let s = 0; s < step.balls.length; s += 5) {
      const chunk = step.balls.slice(s, s + 5);
      chunk.forEach((p, j) => points.push({ step, p, m: chunk.length, j }));
    }
  }
  const buf = new Uint8Array(points.length * 12 + 4);
  points.forEach(({ step, p, m, j }, i) => {
    writePoint(buf, i * 12, lookup(step.ball, step.spin, step.power, p.x), {
      repeatDelay: rd,
      b7: step.orderRandom ? 0x80 : 0,
      ballTime: step.ballTime,
      groupSize: m,
      targetMode: m > 1 && j === 0 ? 1 : 0,
      orderRandom: step.orderRandom ? 1 : 0,
    });
  });
  writeTrailer(buf, points.length * 12, reps);
  return buf;
}

export function splitIntoChunks(frame, size = DEFAULT_CHUNK) {
  const chunks = [];
  for (let off = 0; off < frame.length; off += size) chunks.push(frame.slice(off, off + size));
  return chunks;
}

export function parseFrame(frame) {
  if (frame.length < 17) return null;
  const payloadLen = (frame[12] << 8) | frame[13];
  if (frame.length !== 14 + payloadLen + 3) return null;
  const deviceId = toHex(frame.slice(2, 10), '');
  const payload = frame.slice(14, 14 + payloadLen);
  let firmwareVersion = null;
  if (frame[11] === RESP_FIRMWARE && payloadLen === 4) {
    // Same rendering as the Android app: each byte in decimal, "00 01 01 04" -> "01.14".
    const [a, b, c, d] = Array.from(payload, (x) => (x << 24) >> 24);
    firmwareVersion = `${a}${b}.${c}${d}`;
  }
  return { cmd: frame[11], status: frame[10], deviceId, payload, firmwareVersion };
}

/**
 * Reassembles notification fragments into whole frames, mirroring RobotManager.handleNotification.
 * Keep one per characteristic: the robot mirrors every reply on fec8 and fed6, and interleaving
 * both streams into one buffer could splice two frames together.
 */
export class FrameAssembler {
  constructor() { this.buf = []; }

  reset() { this.buf = []; }

  push(bytes) {
    const out = [];
    const b = this.buf;
    b.push(...bytes);
    while (b.length >= 17) {
      const start = b.indexOf(FRAME_START);
      if (start === -1) { b.length = 0; break; }
      if (start > 0) b.splice(0, start);
      if (b.length < 17) break;
      if (b[10] !== FRAME_START) { b.shift(); continue; }
      const total = 14 + ((b[12] << 8) | b[13]) + 3;
      if (b.length < total) break;
      if (b[total - 1] === FRAME_END) out.push(Uint8Array.from(b.splice(0, total)));
      else b.shift();
    }
    return out;
  }
}

export function toHex(bytes, sep = ' ') {
  return Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join(sep);
}

// ── Motor table (base-conf.json) ─────────────────────────────────────────

export class MotorTable {
  constructor(entries) {
    this.entries = entries;
    this.index = new Map(entries.map((e) => [key(e.ball, e.spin, e.power, e.landarea), e]));
  }

  lookup(ball, spin, power, landarea) {
    return this.index.get(key(ball, spin, power, landarea)) ?? null;
  }

  validLandareas(ball, spin, power) {
    return new Set(this.entries.filter((e) => e.ball === ball && e.spin === spin && e.power === power).map((e) => e.landarea));
  }

  validPowers(ball, spin) {
    return new Set(this.entries.filter((e) => e.ball === ball && e.spin === spin).map((e) => e.power));
  }

  validSpins(ball) {
    return new Set(this.entries.filter((e) => e.ball === ball).map((e) => e.spin));
  }
}

const key = (b, s, p, l) => `${b}/${s}/${p}/${l}`;

// ── Play modes (PlayResolver.kt) ─────────────────────────────────────────

export const ballsPerPatternBasic = (t) => t.points.length;
export const ballsPerPatternAdvanced = (t) => t.steps.reduce((n, s) => n + s.balls.length, 0);
export const patternTenthsBasic = (t) => t.points.length * t.ballTime;
export const patternTenthsAdvanced = (t) => t.steps.reduce((n, s) => n + s.balls.length * s.ballTime, 0);

const ceilDiv = (a, b) => (b <= 0 ? 1 : Math.ceil(a / b));

/** mode: 'reps' | 'balls' | 'timed'. Returns the firmware repeat count, plus seconds to stop after for 'timed'. */
export function resolvePlay(mode, { reps, ballCount, durationSec, ballsPerPattern, patternTenths }) {
  const bpp = Math.max(1, ballsPerPattern);
  switch (mode) {
    case 'balls':
      return { reps: clamp(ceilDiv(ballCount, bpp), 1, MAX_REPS), timedSec: null };
    case 'timed':
      return { reps: clamp(ceilDiv(durationSec * 10, Math.max(1, patternTenths)), 1, MAX_REPS), timedSec: durationSec };
    default:
      return { reps: clamp(reps, 1, MAX_REPS), timedSec: null };
  }
}

// ── Labels ───────────────────────────────────────────────────────────────

export const BALL_LABELS = ['Serve', 'Normal', 'Lob'];
export const SPIN_LABELS = ['Max Topspin', 'Topspin', 'Float', 'Backspin', 'Max Backspin'];
export const POWER_LABELS = ['Extreme', 'Strong', 'Medium', 'Light'];
export const LAND_LABELS = ['Single Ball', 'Sequence', 'Random'];
