// Protocol tests. Open test/index.html through any local web server, or run test/run.sh.
// Vectors marked "HCI" are bytes captured from a real robot / the original Joola app.
import * as P from '../js/protocol.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push(`ok   ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`);
}
const hex = (b) => P.toHex(b);

test('connect frame matches the HCI capture byte for byte', () => {
  eq(hex(P.buildConnectFrame('98D331F33ED50001')), '68 01 98 d3 31 f3 3e d5 00 01 68 89 00 01 00 11 2c 16');
});

test('frame framing, length and device id', () => {
  const f = P.buildFrame('aabbccdd11223344', 0x01, [1, 2, 3, 4, 5]);
  eq(f.length, 22); eq(f[0], 0x68); eq(f[1], 0x01); eq(f[10], 0x68); eq(f[11], 0x01);
  eq(Array.from(f.slice(2, 10)), [0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22, 0x33, 0x44]);
  eq(f[f.length - 1], 0x16);
  const big = P.buildFrame('00', 0x01, new Uint8Array(256));
  eq((big[12] << 8) | big[13], 256);
});

test('short device id is zero padded', () => {
  eq(Array.from(P.buildFrame('aabb', 0x89, [0]).slice(2, 10)), [0xaa, 0xbb, 0, 0, 0, 0, 0, 0]);
});

test('CRC covers everything before it', () => {
  const f = P.buildVersionQueryFrame('98D331F33ED50001');
  const crc = P.crcCCITT(f, 0, f.length - 3);
  eq([f[f.length - 3], f[f.length - 2]], [crc >> 8, crc & 0xff]);
});

test('stop, pre-pattern and post-pattern opcodes', () => {
  const id = '98D331F33ED50001';
  eq(P.buildStopFrame(id, 'V2')[11], 0x05);
  eq(P.buildStopFrame(id, 'V1')[11], 0x99);
  const pre = P.buildPrePatternFrame(id); eq([pre[11], pre[14]], [0x04, 0x02]);
  const post = P.buildPostPatternFrame(id); eq([post[11], post[14]], [0x03, 0x00]);
  eq(P.buildVersionQueryFrame(id).length, 17); // empty payload
});

test('device id from advertised name', () => {
  eq(P.deviceIdFromName('J-98D331F33ED50001'), '98D331F33ED50001');
  eq(P.deviceIdFromName('J-98D3'), '98D3000000000000');
  eq(P.deviceIdFromName('J-NOTHEXNOTHEXNOT'), P.ZERO_ID);
  eq(P.deviceIdFromName('Speaker'), P.ZERO_ID);
});

const params = (n) => ({ m1speed: n, m2speed: n + 1, xaxis: n + 2, yaxis: n + 3, zaxis: n + 4 });
const lookup = (b, s, p, cell) => params(cell);

test('basic random drill sets b7=0x80, b10=2, b11=1 on every point', () => {
  const buf = P.encodeBasicPattern({ ball: 1, spin: 2, power: 2, landType: 2, ballTime: 9, times: 20, points: [{ x: 1 }, { x: 5 }, { x: 13 }] }, lookup);
  eq(buf.length, 3 * 12 + 4);
  for (let i = 0; i < 3; i++) eq([buf[i * 12 + 7], buf[i * 12 + 9], buf[i * 12 + 10], buf[i * 12 + 11]], [0x80, 1, 2, 1], `point ${i}`);
  eq(Array.from(buf.slice(36)), [20, 1, 0, 0]);
});

test('basic sequence drill: motor bytes, timing, no random flags', () => {
  const buf = P.encodeBasicPattern({ ball: 1, spin: 2, power: 2, landType: 1, ballTime: 9, times: 20, points: [{ x: 3 }, { x: 7 }] }, lookup, { times: 400, ballTime: 12 });
  eq(Array.from(buf.slice(0, 12)), [3, 4, 5, 6, 7, 0, 1, 0, 12, 1, 0, 0]);
  eq(buf[24], 255, 'reps clamp');
});

test('single ball payload', () => {
  eq(Array.from(P.encodeSingleBall(params(10), 15)), [10, 11, 12, 13, 14, 0, 1, 0, 15, 1, 0, 0, 1, 1, 0, 0]);
});

test('advanced "Half Long 2/3 FH Loop" layout (PROTOCOL.md worked example)', () => {
  const step = { ball: 1, spin: 1, power: 1, ballTime: 10, orderRandom: true, balls: [5, 5, 11, 11, 20].map((x) => ({ x })) };
  const buf = P.encodeAdvancedPattern({ repeatNum: 15, repeatDelay: 1, steps: [step, step] }, lookup);
  eq(buf.length, 10 * 12 + 4);
  const flags = (i) => [buf[i * 12 + 7], buf[i * 12 + 9], buf[i * 12 + 10], buf[i * 12 + 11]];
  eq(flags(0), [0x80, 5, 1, 1], 'leader 1');
  eq(flags(1), [0x80, 5, 0, 1]);
  eq(flags(5), [0x80, 5, 1, 1], 'leader 2');
  eq(buf[1 * 12], 5, 'duplicate position kept');
  eq(Array.from(buf.slice(120)), [15, 1, 0, 0]);
});

test('advanced: single-ball fixed step and >5 balls chunked into groups', () => {
  const buf = P.encodeAdvancedPattern({ repeatNum: 3, repeatDelay: 0, steps: [
    { ball: 0, spin: 3, power: 3, ballTime: 14, orderRandom: false, balls: [{ x: 7 }] },
    { ball: 1, spin: 3, power: 3, ballTime: 14, orderRandom: false, balls: [1, 2, 3, 4, 5, 6, 7].map((x) => ({ x })) },
  ] }, lookup);
  eq([buf[6], buf[7], buf[9], buf[10], buf[11]], [1, 0, 1, 0, 0], 'step 1 (repeatDelay floors at 1)');
  eq([buf[12 + 9], buf[12 + 10]], [5, 1], 'first chunk leader');
  eq([buf[6 * 12 + 9], buf[6 * 12 + 10]], [2, 1], 'second chunk leader');
});

test('parse firmware reply: 00 01 01 04 -> 01.14', () => {
  const f = P.buildFrame('98D331F33ED50001', 0x85, [0, 1, 1, 4]);
  const r = P.parseFrame(f);
  eq([r.cmd, r.firmwareVersion, r.deviceId], [0x85, '01.14', '98d331f33ed50001']);
});

test('assembler: fragments, leading junk, two frames in one push', () => {
  const a = new P.FrameAssembler();
  const f1 = P.buildFrame('98D331F33ED50001', 0x85, [0, 2, 0, 2]);
  const f2 = P.buildFrame('98D331F33ED50001', 0x8f, [0x10]);
  eq(a.push([0x00, 0x16, ...f1.slice(0, 7)]).length, 0);
  eq(a.push(f1.slice(7, 15)).length, 0);
  const out = a.push([...f1.slice(15), ...f2]);
  eq(out.map((f) => f[11]), [0x85, 0x8f]);
  eq(a.buf.length, 0);
});

test('resolvePlay matches PlayResolver', () => {
  const base = { reps: 20, ballCount: 30, durationSec: 60, ballsPerPattern: 4, patternTenths: 36 };
  eq(P.resolvePlay('reps', base), { reps: 20, timedSec: null });
  eq(P.resolvePlay('balls', base), { reps: 8, timedSec: null });
  eq(P.resolvePlay('timed', base), { reps: 17, timedSec: 60 });
  eq(P.resolvePlay('reps', { ...base, reps: 999 }).reps, 255);
});

const [base, basic, advanced] = await Promise.all(
  ['base-conf', 'basic-trainings', 'advanced-trainings'].map((f) => fetch(`../data/${f}.json`).then((r) => r.json())));
const motors = new P.MotorTable(base);
test(`bundled data: ${base.length} motor entries, ${basic.length} basic, ${advanced.length} advanced drills`, () => {
  const missing = [];
  for (const d of basic) for (const p of d.points) if (!motors.lookup(d.ball, d.spin, d.power, p.x)) missing.push(`${d.name}@${p.x}`);
  for (const d of advanced) for (const s of d.steps) for (const p of s.balls) if (!motors.lookup(s.ball, s.spin, s.power, p.x)) missing.push(`${d.name}@${p.x}`);
  if (missing.length) results.push(`note ${missing.length} drill positions have no base-conf entry (sent as zeros, same as Android): ${missing.slice(0, 5).join(', ')}…`);
  eq(base.length, 465);
});

const failed = results.filter((r) => r.startsWith('FAIL')).length;
results.push(failed ? `\n${failed} FAILED` : `\nALL ${results.filter((r) => r.startsWith('ok')).length} PASSED`);
document.getElementById('out').textContent = results.join('\n');
