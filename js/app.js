import * as P from './protocol.js';
import { Robot } from './robot.js';
import * as C from './calibration.js';

const APP_VERSION = '0.2.0';
const $ = (id) => document.getElementById(id);

// ── Persistence (per-device conveniences only; everything works without it) ──

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`tablebot.${key}`);
    return v ? { ...fallback, ...JSON.parse(v) } : fallback;
  } catch { return fallback; }
}

function save(key, value) {
  try { localStorage.setItem(`tablebot.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
}

const settings = load('settings', { chunk: P.DEFAULT_CHUNK, settleMs: 600, robotType: 'V2' });
const custom = load('custom', { ball: 1, spin: 2, power: 2, landType: 0, cells: [8], ballTime: 9 });

const robot = new Robot(settings);
let motors = null; // factory table
let cal = null;    // calibration on top of it — use this for anything sent to the robot
let drills = [];
let kindFilter = 'all';
let countdown = null; // { timer, remaining } while a timed drill runs
let nowPlaying = '';

// ── Log ────────────────────────────────────────────────────────────────

const logLines = [];
robot.addEventListener('log', (e) => {
  logLines.push(e.detail);
  if (logLines.length > 400) logLines.shift();
  if (!$('tab-settings').hidden) renderLog();
});

function renderLog() {
  const el = $('log');
  el.textContent = logLines.join('\n');
  el.scrollTop = el.scrollHeight;
}

$('copyLog').onclick = async () => {
  try {
    await navigator.clipboard.writeText(logLines.join('\n'));
    toast('Log copied');
  } catch {
    toast('Copy failed — long-press the log to select it');
  }
};
$('clearLog').onclick = () => { logLines.length = 0; renderLog(); };

// ── Toast ──────────────────────────────────────────────────────────────

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ── Connection bar ─────────────────────────────────────────────────────

function renderConnection() {
  const dot = $('dot');
  dot.className = 'dot';
  if (robot.state === 'connecting') dot.classList.add('connecting');
  if (robot.state === 'connected') dot.classList.add(robot.verified ? 'connected' : 'unverified');

  $('status').textContent = robot.status || 'Not connected';
  $('sub').textContent = robot.firmware ? `Firmware v${robot.firmware}` : '';

  const btn = $('connectBtn');
  btn.disabled = robot.state === 'connecting';
  btn.textContent = robot.state === 'connected' ? 'Disconnect' : robot.device ? 'Reconnect' : 'Connect';

  $('stopBar').hidden = !(robot.playing || countdown);
  renderNowPlaying();
}

function renderNowPlaying() {
  const left = countdown ? `<small>${fmtTime(countdown.remaining)} left</small>` : '';
  $('nowPlaying').innerHTML = `${esc(nowPlaying)}${left}`;
}

robot.addEventListener('change', () => {
  renderConnection();
  if (robot.state === 'connected') wakeLock();
});
robot.addEventListener('done', () => { clearCountdown(); toast('Drill finished'); });

$('connectBtn').onclick = () => {
  if (robot.state === 'connected') robot.disconnect();
  else if (robot.device) robot.reconnect();
  else robot.connect();
};

$('stopBtn').onclick = async () => {
  clearCountdown();
  try { await robot.stop(); } catch (e) { toast(`Stop failed: ${e.message}`); }
  renderConnection();
};

// Keep the screen on while connected: if the phone locks, the page is suspended, the keepalive
// stops, and so does the link.
let wakeSentinel = null;
async function wakeLock() {
  if (wakeSentinel || !('wakeLock' in navigator)) return;
  try {
    wakeSentinel = await navigator.wakeLock.request('screen');
    wakeSentinel.addEventListener('release', () => { wakeSentinel = null; });
  } catch { /* not supported in this browser — nothing to do */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && robot.state === 'connected') wakeLock();
});

// ── Playing ────────────────────────────────────────────────────────────

async function playPayload(name, payload, timedSec) {
  if (robot.state !== 'connected') { toast('Connect to the robot first'); return; }
  clearCountdown();
  nowPlaying = name;
  try {
    await robot.play(payload);
  } catch (e) {
    toast(`Could not start: ${e.message}`);
    return;
  }
  if (timedSec && robot.playing) startCountdown(timedSec);
  renderConnection();
}

function startCountdown(sec) {
  countdown = { remaining: sec, timer: setInterval(() => {
    countdown.remaining--;
    renderNowPlaying();
    if (countdown.remaining <= 0) {
      clearCountdown();
      robot.stop().catch(() => {});
      toast('Time is up');
    }
  }, 1000) };
  renderConnection();
}

function clearCountdown() {
  if (countdown) clearInterval(countdown.timer);
  countdown = null;
  renderConnection();
}

const lookup = (b, s, p, cell) => cal.lookup(b, s, p, cell);

// ── Play-mode picker (reps / ball count / timed) ─────────────────────────

function playModePicker(container, defaults) {
  const state = { mode: 'reps', reps: defaults.reps, ballCount: defaults.ballCount ?? 30, durationSec: defaults.durationSec ?? 60 };
  container.innerHTML = `
    <label class="lbl">Play for</label>
    <div class="seg" data-role="mode">
      <button data-v="reps" class="on">Repetitions</button>
      <button data-v="balls">Balls</button>
      <button data-v="timed">Time</button>
    </div>
    <div style="margin-top:8px"><input type="number" inputmode="numeric" data-role="value"></div>
    <p class="hint" data-role="hint"></p>`;
  const seg = container.querySelector('[data-role=mode]');
  const input = container.querySelector('[data-role=value]');
  const hint = container.querySelector('[data-role=hint]');

  const field = () => ({ reps: 'reps', balls: 'ballCount', timed: 'durationSec' })[state.mode];
  const sync = () => {
    input.value = state[field()];
    hint.textContent = {
      reps: 'Times through the whole pattern (1–255).',
      balls: 'Total balls; rounded up to whole patterns.',
      timed: 'Seconds. The drill is stopped when the time is up.',
    }[state.mode];
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === state.mode));
  };
  seg.onclick = (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v) { state.mode = v; sync(); }
  };
  input.oninput = () => {
    const n = parseInt(input.value, 10);
    if (n > 0) state[field()] = n;
  };
  sync();
  return state;
}

// ── Drill library ───────────────────────────────────────────────────────

function drillSummary(d) {
  if (d.kind === 'basic') return `${P.BALL_LABELS[d.ball]} · ${P.SPIN_LABELS[d.spin]} · ${P.POWER_LABELS[d.power]} · ${P.LAND_LABELS[d.landType]}`;
  return `Advanced · ${d.steps.length} step${d.steps.length === 1 ? '' : 's'} · ${P.ballsPerPatternAdvanced(d)} balls`;
}

function renderDrillList() {
  const q = $('search').value.trim().toLowerCase();
  const items = drills.filter((d) =>
    (kindFilter === 'all' || d.kind === kindFilter) &&
    (!q || d.name.toLowerCase().includes(q) || (d.tags ?? []).some((t) => t.toLowerCase().includes(q))));
  $('drillList').innerHTML = items.length
    ? items.map((d) => `
      <li class="item" data-key="${d.kind}:${d.id}">
        <div class="item-name">${esc(d.name)}</div>
        <div class="item-meta">${esc(drillSummary(d))} · ${esc(d.skillLevel?.skillLevel ?? '')}</div>
        ${(d.tags ?? []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
      </li>`).join('')
    : '<li class="empty">No drills match</li>';
}

$('search').oninput = renderDrillList;
$('kindFilter').onclick = (e) => {
  const v = e.target.closest('button')?.dataset.v;
  if (!v) return;
  kindFilter = v;
  $('kindFilter').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  renderDrillList();
};
$('drillList').onclick = (e) => {
  const key = e.target.closest('.item')?.dataset.key;
  const d = key && drills.find((x) => `${x.kind}:${x.id}` === key);
  if (d) openDrill(d);
};

function miniGrid(cells, ordered) {
  const order = new Map();
  cells.forEach((c, i) => { if (!order.has(c)) order.set(c, i + 1); });
  let html = '<div class="grid-wrap"><div class="net">NET · robot side</div><div class="grid mini">';
  for (let c = 1; c <= 15; c++) {
    const on = order.has(c);
    html += `<div class="cell ${on ? 'on' : ''}">${c}${on && ordered ? `<span class="order">${order.get(c)}</span>` : ''}</div>`;
  }
  return `${html}</div><div class="net">you</div></div>`;
}

let sheetPlay = null;

function openDrill(d) {
  $('dName').textContent = d.name;
  let picker;
  if (d.kind === 'basic') {
    $('dMeta').textContent = `${drillSummary(d)} · interval ${d.ballTime}`;
    $('dBody').innerHTML = miniGrid(d.points.map((p) => p.x), d.landType === 1);
    picker = playModePicker($('dPlayMode'), { reps: d.times });
    sheetPlay = () => {
      const r = P.resolvePlay(picker.mode, { ...picker, ballsPerPattern: P.ballsPerPatternBasic(d), patternTenths: P.patternTenthsBasic(d) });
      return [P.encodeBasicPattern(d, lookup, { times: r.reps }), r.timedSec];
    };
  } else {
    $('dMeta').textContent = drillSummary(d);
    $('dBody').innerHTML = d.steps.map((s, i) => `
      <div class="step"><b>${i + 1}.</b> ${P.BALL_LABELS[s.ball]} · ${P.SPIN_LABELS[s.spin]} · ${P.POWER_LABELS[s.power]}
        · interval ${s.ballTime}<br>
        Position${s.balls.length > 1 ? 's' : ''} ${s.balls.map((b) => b.x).join(', ')}
        ${s.balls.length > 1 ? '<span class="tag">random target</span>' : ''}
        ${s.orderRandom ? '<span class="tag">shuffled order</span>' : ''}
      </div>`).join('');
    picker = playModePicker($('dPlayMode'), { reps: d.repeatNum });
    sheetPlay = () => {
      const r = P.resolvePlay(picker.mode, { ...picker, ballsPerPattern: P.ballsPerPatternAdvanced(d), patternTenths: P.patternTenthsAdvanced(d) });
      return [P.encodeAdvancedPattern(d, lookup, { repeatNum: r.reps }), r.timedSec];
    };
  }
  $('dPlay').onclick = () => {
    const [payload, timedSec] = sheetPlay();
    closeSheet();
    playPayload(d.name, payload, timedSec);
  };
  $('sheet').hidden = false;
}

function closeSheet() { $('sheet').hidden = true; }
$('dClose').onclick = closeSheet;
$('sheet').onclick = (e) => { if (e.target === $('sheet')) closeSheet(); };

// ── Custom drill ────────────────────────────────────────────────────────

const MODE_HINTS = [
  'Every ball goes to the same position.',
  'Balls go to the positions in the order you tap them.',
  'Each ball goes to a random one of the selected positions.',
];

let customPicker;

function segButtons(el, labels, value, enabled, onPick) {
  el.innerHTML = labels.map((l, i) =>
    `<button data-v="${i}" class="${i === value ? 'on' : ''}" ${enabled && !enabled.has(i) ? 'disabled' : ''}>${l}</button>`).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled) onPick(Number(b.dataset.v));
  };
}

function normaliseCustom() {
  const spins = motors.validSpins(custom.ball);
  if (!spins.has(custom.spin)) custom.spin = [...spins].sort()[0] ?? 2;
  const powers = motors.validPowers(custom.ball, custom.spin);
  if (!powers.has(custom.power)) custom.power = [...powers].sort()[0] ?? 2;
  const valid = motors.validLandareas(custom.ball, custom.spin, custom.power);
  custom.cells = custom.cells.filter((c) => valid.has(c));
  if (custom.landType === 0) custom.cells = custom.cells.slice(0, 1);
  if (custom.landType === 2) custom.cells = [...new Set(custom.cells)];
}

function renderCustom() {
  normaliseCustom();
  save('custom', custom);
  const rerender = (patch) => { Object.assign(custom, patch); renderCustom(); };

  segButtons($('cBall'), P.BALL_LABELS, custom.ball, null, (v) => rerender({ ball: v }));
  segButtons($('cSpin'), P.SPIN_LABELS, custom.spin, motors.validSpins(custom.ball), (v) => rerender({ spin: v }));
  segButtons($('cPower'), P.POWER_LABELS, custom.power, motors.validPowers(custom.ball, custom.spin), (v) => rerender({ power: v }));
  segButtons($('cMode'), P.LAND_LABELS, custom.landType, null, (v) => rerender({ landType: v }));
  $('cModeHint').textContent = MODE_HINTS[custom.landType];
  $('cGridHint').textContent = custom.landType === 0 ? '— tap one' : '— tap to add, tap again to remove';

  const valid = motors.validLandareas(custom.ball, custom.spin, custom.power);
  const ordered = custom.landType === 1;
  let html = '';
  for (let c = 1; c <= 15; c++) {
    const idx = custom.cells.indexOf(c);
    html += `<button class="cell ${idx >= 0 ? 'on' : ''}" data-c="${c}" ${valid.has(c) ? '' : 'disabled'}>${c}${idx >= 0 && ordered ? `<span class="order">${idx + 1}</span>` : ''}</button>`;
  }
  $('cGrid').innerHTML = html;

  $('cTime').value = custom.ballTime;
  $('cTimeVal').textContent = `${custom.ballTime} (1 fastest · 20 slowest)`;
  $('cPlay').disabled = custom.cells.length === 0;
  $('cTest').disabled = custom.cells.length === 0;
}

$('cGrid').onclick = (e) => {
  const b = e.target.closest('.cell');
  if (!b || b.disabled) return;
  const c = Number(b.dataset.c);
  const has = custom.cells.includes(c);
  if (custom.landType === 0) custom.cells = [c];
  else custom.cells = has ? custom.cells.filter((x) => x !== c) : [...custom.cells, c];
  renderCustom();
};

$('cTime').oninput = () => {
  custom.ballTime = Number($('cTime').value);
  $('cTimeVal').textContent = `${custom.ballTime} (1 fastest · 20 slowest)`;
  save('custom', custom);
};

function customDrill() {
  return {
    name: 'Custom drill', ball: custom.ball, spin: custom.spin, power: custom.power,
    landType: custom.landType, ballTime: custom.ballTime, times: customPicker.reps,
    points: custom.cells.map((x) => ({ x, y: 2 })),
  };
}

$('cTest').onclick = () => {
  const params = lookup(custom.ball, custom.spin, custom.power, custom.cells[0]);
  if (!params) { toast('No motor settings for that position'); return; }
  playPayload('Test ball', P.encodeSingleBall(params, custom.ballTime), null);
};

$('cPlay').onclick = () => {
  const d = customDrill();
  const r = P.resolvePlay(customPicker.mode, { ...customPicker, ballsPerPattern: P.ballsPerPatternBasic(d), patternTenths: P.patternTenthsBasic(d) });
  playPayload(d.name, P.encodeBasicPattern(d, lookup, { times: r.reps }), r.timedSec);
};

// ── Calibration ────────────────────────────────────────────────────────

const CAL_KEY = 'tablebot.calibration';
const calibUi = load('calibUi', { ball: 1, spin: 1, power: 2, cell: 13, autoFire: false });
let working = null; // motor values being tuned for the selected cell
let dirty = false;  // working differs from what is saved

function loadCalibration() {
  try {
    const raw = localStorage.getItem(CAL_KEY);
    if (raw) return C.Calibration.fromJSON(JSON.parse(raw), motors);
  } catch { /* unreadable or blocked storage — start from factory */ }
  return new C.Calibration(motors);
}

function saveCalibration() {
  try {
    localStorage.setItem(CAL_KEY, JSON.stringify(cal.toJSON()));
  } catch {
    toast('Could not save in this browser — use Save to file');
  }
}

const calCombo = () => [calibUi.ball, calibUi.spin, calibUi.power];

function resetWorking() {
  working = C.motorValues(cal.lookup(...calCombo(), calibUi.cell));
  dirty = false;
}

function confirmDiscard() {
  return !dirty || confirm(`Discard the unsaved changes to cell ${calibUi.cell}?`);
}

function normaliseCalib() {
  const spins = motors.validSpins(calibUi.ball);
  if (!spins.has(calibUi.spin)) calibUi.spin = [...spins].sort()[0] ?? 2;
  const powers = motors.validPowers(calibUi.ball, calibUi.spin);
  if (!powers.has(calibUi.power)) calibUi.power = [...powers].sort()[0] ?? 2;
  const valid = motors.validLandareas(...calCombo());
  if (!valid.has(calibUi.cell)) calibUi.cell = [13, 8, 3].find((c) => valid.has(c)) ?? [...valid][0];
}

const SOURCE_TEXT = {
  good: 'Marked good',
  auto: 'Estimated from your good cells',
  factory: 'Factory settings',
};

function renderCalib() {
  if (!cal) return;
  normaliseCalib();
  save('calibUi', calibUi);
  if (!working) resetWorking();
  const combo = calCombo();
  const pickCombo = (patch) => {
    if (!confirmDiscard()) return;
    Object.assign(calibUi, patch);
    working = null;
    renderCalib();
  };

  segButtons($('kBall'), P.BALL_LABELS, calibUi.ball, null, (v) => pickCombo({ ball: v }));
  segButtons($('kSpin'), P.SPIN_LABELS, calibUi.spin, motors.validSpins(calibUi.ball), (v) => pickCombo({ spin: v }));
  segButtons($('kPower'), P.POWER_LABELS, calibUi.power, motors.validPowers(calibUi.ball, calibUi.spin), (v) => pickCombo({ power: v }));

  const suggested = C.suggestedCells(motors, ...combo);
  let html = '';
  for (let c = 1; c <= 15; c++) {
    const src = cal.source(...combo, c);
    const cls = ['cell', src === 'good' ? 'good' : src === 'auto' ? 'auto' : '', c === calibUi.cell ? 'sel' : ''].join(' ');
    const mark = src === 'good' ? '✓' : suggested.includes(c) ? '○' : '';
    html += `<button class="${cls}" data-c="${c}" ${src ? '' : 'disabled'}>${c}${mark ? `<span class="mark">${mark}</span>` : ''}</button>`;
  }
  $('kGrid').innerHTML = html;

  const goodCells = cal.anchorsFor(...combo).map((a) => a.cell);
  const good = goodCells.length;
  const reachable = motors.validLandareas(...combo).size;
  const done = suggested.filter((c) => goodCells.includes(c)).length;
  $('kSummary').textContent = (good
    ? `${good} good cell${good === 1 ? '' : 's'} (green) · the other ${reachable - good} are estimated from ${good === 1 ? 'it' : 'them'}. `
    : 'Factory settings for this spin and power. ')
    + (done < suggested.length
      ? `Suggested cells (○): ${done} of ${suggested.length} done — the cells between them are then filled in.`
      : 'All suggested cells done.');

  const src = cal.source(...combo, calibUi.cell);
  $('kCellTitle').textContent = `Cell ${calibUi.cell} · ${P.SPIN_LABELS[calibUi.spin]} · ${P.POWER_LABELS[calibUi.power]}`;
  $('kCellSub').textContent = dirty ? `${SOURCE_TEXT[src]} · changed, not saved yet` : SOURCE_TEXT[src];

  const factory = motors.lookup(...combo, calibUi.cell);
  $('kFine').innerHTML = C.FIELDS.map((f) => `
    <div class="fine-row">
      <div class="name">${C.FIELD_LABELS[f]}<small>factory ${factory[f]} · range ${C.RANGES[f][0]}–${C.RANGES[f][1]}</small></div>
      <button class="btn" data-f="${f}" data-d="-1">−</button>
      <span class="num ${working[f] !== factory[f] ? 'changed' : ''}">${working[f]}</span>
      <button class="btn" data-f="${f}" data-d="1">+</button>
    </div>`).join('');

  $('kAuto').checked = calibUi.autoFire;
  $('kUndo').disabled = !dirty;
  $('kForget').disabled = src !== 'good';
  $('kStored').textContent = cal.count
    ? `${cal.count} good cell${cal.count === 1 ? '' : 's'} saved in this browser. Save a file now and then — clearing Bluefy’s website data erases them.`
    : 'Nothing saved yet — drills use the factory settings.';
}

function fireCalib() {
  const params = { ...motors.lookup(...calCombo(), calibUi.cell), ...working };
  playPayload(`Calibrating cell ${calibUi.cell}`, P.encodeSingleBall(params, 9), null);
}

$('kGrid').onclick = (e) => {
  const b = e.target.closest('.cell');
  if (!b || b.disabled || Number(b.dataset.c) === calibUi.cell || !confirmDiscard()) return;
  calibUi.cell = Number(b.dataset.c);
  working = null;
  renderCalib();
};

$('kFire').onclick = fireCalib;

document.querySelector('.pad').onclick = (e) => {
  const a = e.target.closest('button')?.dataset.a;
  if (!a) return;
  working = C.nudge(working, a, C.xDirection(motors, ...calCombo()));
  dirty = true;
  renderCalib();
  if (calibUi.autoFire) fireCalib();
};

$('kFine').onclick = (e) => {
  const b = e.target.closest('button[data-f]');
  if (!b) return;
  const f = b.dataset.f;
  const [lo, hi] = C.RANGES[f];
  working = { ...working, [f]: Math.min(hi, Math.max(lo, working[f] + Number(b.dataset.d))) };
  dirty = true;
  renderCalib();
};

$('kAuto').onchange = () => { calibUi.autoFire = $('kAuto').checked; save('calibUi', calibUi); };

$('kGood').onclick = () => {
  const before = cal.anchorsFor(...calCombo()).length;
  cal.setGood(...calCombo(), calibUi.cell, working);
  saveCalibration();
  resetWorking();
  renderCalib();
  toast(before ? `Cell ${calibUi.cell} saved — estimates updated` : `Cell ${calibUi.cell} saved — the rest of the grid now follows it`);
};

$('kUndo').onclick = () => { resetWorking(); renderCalib(); };

$('kForget').onclick = () => {
  if (!confirm(`Forget cell ${calibUi.cell}?`)) return;
  cal.forget(...calCombo(), calibUi.cell);
  saveCalibration();
  resetWorking();
  renderCalib();
};

$('kResetCombo').onclick = () => {
  if (!confirm(`Forget every good cell for ${P.BALL_LABELS[calibUi.ball]} · ${P.SPIN_LABELS[calibUi.spin]} · ${P.POWER_LABELS[calibUi.power]}?`)) return;
  cal.forgetCombo(...calCombo());
  saveCalibration();
  resetWorking();
  renderCalib();
};

$('kResetAll').onclick = () => {
  if (!confirm('Forget ALL calibration and go back to factory settings?')) return;
  cal.forgetAll();
  saveCalibration();
  resetWorking();
  renderCalib();
};

const calibText = () => JSON.stringify(cal.toJSON(), null, 2);

$('kExport').onclick = async () => {
  const name = `tablebot-calibration-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([calibText()], name, { type: 'application/json' });
  // On iPhone the share sheet ("Save to Files") is the reliable way to get a file out.
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
};

$('kCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText(calibText());
    toast('Calibration copied — paste it into Notes to keep it');
  } catch {
    toast('Copy failed in this browser — use Save to file');
  }
};

function importCalibration(text) {
  let next;
  try {
    next = C.Calibration.fromJSON(JSON.parse(text), motors);
  } catch (e) {
    toast(`Not loaded: ${e instanceof SyntaxError ? 'not valid JSON' : e.message}`);
    return;
  }
  if (cal.count && !confirm(`Replace your ${cal.count} saved good cells with the ${next.count} in this file?`)) return;
  cal = next;
  saveCalibration();
  resetWorking();
  renderCalib();
  toast(`Loaded ${cal.count} good cell${cal.count === 1 ? '' : 's'}`);
}

$('kImport').onclick = () => $('kFile').click();
$('kFile').onchange = async () => {
  const f = $('kFile').files[0];
  $('kFile').value = '';
  if (f) importCalibration(await f.text());
};

$('kPaste').onclick = async () => {
  let text = null;
  try { text = await navigator.clipboard.readText(); } catch { /* not allowed — ask instead */ }
  if (!text) text = prompt('Paste the calibration text');
  if (text) importCalibration(text);
};

// ── Settings ───────────────────────────────────────────────────────────

function bindSetting(id, key, parse) {
  const el = $(id);
  const sync = () => el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', parse(b.dataset.v) === settings[key]));
  el.onclick = (e) => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === undefined) return;
    settings[key] = parse(v);
    save('settings', settings);
    sync();
  };
  sync();
}

bindSetting('sType', 'robotType', String);
bindSetting('sChunk', 'chunk', Number);
bindSetting('sSettle', 'settleMs', Number);
$('version').textContent = `TableBot Web ${APP_VERSION}`;

// ── Tabs ───────────────────────────────────────────────────────────────

document.querySelector('.tabs').onclick = (e) => {
  const tab = e.target.closest('.tab')?.dataset.tab;
  if (!tab) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  for (const name of ['drills', 'custom', 'calib', 'settings']) $(`tab-${name}`).hidden = name !== tab;
  if (tab === 'settings') renderLog();
  if (tab === 'calib') renderCalib();
};

// ── Helpers ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ── Start ──────────────────────────────────────────────────────────────

async function init() {
  $('unsupported').hidden = Robot.supported;
  renderConnection();

  const get = (f) => fetch(`data/${f}`).then((r) => {
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    return r.json();
  });
  try {
    const [base, basic, advanced] = await Promise.all([get('base-conf.json'), get('basic-trainings.json'), get('advanced-trainings.json')]);
    motors = new P.MotorTable(base);
    cal = loadCalibration();
    drills = [
      ...basic.map((d) => ({ ...d, kind: 'basic' })),
      ...advanced.filter((d) => d.steps?.length).map((d) => ({ ...d, kind: 'advanced' })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    $('drillList').innerHTML = `<li class="empty">Could not load drill data (${esc(e.message)})</li>`;
    return;
  }

  renderDrillList();
  customPicker = playModePicker($('cPlayMode'), { reps: 20 });
  renderCustom();
  renderCalib();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is a bonus, not a requirement */ });
  }
}

init();
