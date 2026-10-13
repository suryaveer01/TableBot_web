// On-table calibration: hand-tuned "good" cells, and an estimate for every other cell from them.
// Pure logic (no DOM, no Bluetooth) so it can be tested in isolation: see test/.
//
// What the factory table (base-conf.json) shows about the five motor values, per ball/spin/power:
//   - X (side aim) runs roughly linearly across the five columns, and nothing else changes along
//     a row;
//   - depth comes mostly from the wheel speeds, which rise for the cells further from the net;
//     Y moves a little with depth and Z not at all.
// So a good cell is stored as an absolute set of values, and its correction (good minus factory)
// is spread over the rest of the grid:
//   - A cell with good cells on both sides of it in its row takes the straight-line blend of their
//     corrections; failing that, the same between good cells above and below it in its column.
//     With the 9 suggested cells (columns 1, 3, 5 of every row) that covers every other cell.
//   - Anything else comes from a plane fitted through all the good cells. One good cell shifts
//     every cell by the same amount; two or three also let the correction change across columns
//     and/or rows. Slopes are only fitted along directions the good cells actually span: two cells
//     in the same row say nothing about depth, so the depth slope stays at zero.

export const FIELDS = ['m1speed', 'm2speed', 'xaxis', 'yaxis', 'zaxis'];

// Same limits as the Android calibration sliders.
export const RANGES = {
  m1speed: [0, 36],
  m2speed: [0, 36],
  xaxis: [0, 40],
  yaxis: [0, 32],
  zaxis: [0, 20],
};

export const FIELD_LABELS = {
  m1speed: 'Top wheel (M1)',
  m2speed: 'Bottom wheel (M2)',
  xaxis: 'Side aim (X)',
  yaxis: 'Elevation (Y)',
  zaxis: 'Z',
};

const RIDGE = 0.01; // keeps the slope fit solvable when the good cells are all in one row/column

const clampField = (f, v) => Math.min(RANGES[f][1], Math.max(RANGES[f][0], Math.round(v)));
const rowOf = (cell) => Math.floor((cell - 1) / 5);
const colOf = (cell) => (cell - 1) % 5;
const comboKey = (b, s, p) => `${b}/${s}/${p}`;
const pick = (e) => Object.fromEntries(FIELDS.map((f) => [f, e[f]]));

/**
 * Fits correction = mean + slopeCol·(col − meanCol) + slopeRow·(row − meanRow) per field, over
 * points [{ cell, delta: { field: n } }]. Returns cell -> { field: correction } (unrounded).
 */
export function fitCorrections(points) {
  if (points.length === 0) return () => Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const n = points.length;
  const cs = points.map((p) => colOf(p.cell));
  const rs = points.map((p) => rowOf(p.cell));
  const cMean = cs.reduce((a, b) => a + b, 0) / n;
  const rMean = rs.reduce((a, b) => a + b, 0) / n;
  let scc = 0, srr = 0, scr = 0;
  for (let i = 0; i < n; i++) {
    const dc = cs[i] - cMean, dr = rs[i] - rMean;
    scc += dc * dc; srr += dr * dr; scr += dc * dr;
  }
  // [scc+λ  scr ] [bc]   [Σ dc·d]
  // [scr   srr+λ] [br] = [Σ dr·d]
  const a11 = scc + RIDGE, a22 = srr + RIDGE, det = a11 * a22 - scr * scr;
  const model = {};
  for (const f of FIELDS) {
    const ds = points.map((p) => p.delta[f]);
    const mean = ds.reduce((a, b) => a + b, 0) / n;
    let yc = 0, yr = 0;
    for (let i = 0; i < n; i++) {
      yc += (cs[i] - cMean) * (ds[i] - mean);
      yr += (rs[i] - rMean) * (ds[i] - mean);
    }
    model[f] = { mean, bc: (a22 * yc - scr * yr) / det, br: (a11 * yr - scr * yc) / det };
  }
  return (cell) => {
    const dc = colOf(cell) - cMean, dr = rowOf(cell) - rMean;
    return Object.fromEntries(FIELDS.map((f) => [f, model[f].mean + model[f].bc * dc + model[f].br * dr]));
  };
}

/**
 * Correction for one cell from the good cells' corrections ([{ cell, delta }]): a blend between
 * the nearest good cells either side of it in its row, else above and below it in its column,
 * else the plane fit.
 */
export function estimateCorrection(points, cell, plane = fitCorrections(points)) {
  const between = (same, pos) => {
    const line = points.filter((p) => same(p.cell));
    const before = line.filter((p) => pos(p.cell) < pos(cell)).sort((a, b) => pos(b.cell) - pos(a.cell))[0];
    const after = line.filter((p) => pos(p.cell) > pos(cell)).sort((a, b) => pos(a.cell) - pos(b.cell))[0];
    if (!before || !after) return null;
    const t = (pos(cell) - pos(before.cell)) / (pos(after.cell) - pos(before.cell));
    return Object.fromEntries(FIELDS.map((f) => [f, before.delta[f] + (after.delta[f] - before.delta[f]) * t]));
  };
  return between((c) => rowOf(c) === rowOf(cell), colOf)
    ?? between((c) => colOf(c) === colOf(cell), rowOf)
    ?? plane(cell);
}

/** The cells worth calibrating by hand: columns 1, 3 and 5 of each row this shot can reach. */
export function suggestedCells(factory, b, s, p) {
  return [1, 3, 5, 6, 8, 10, 11, 13, 15].filter((c) => factory.lookup(b, s, p, c));
}

export class Calibration {
  /** factory: a protocol.js MotorTable. anchors: key "ball/spin/power/cell" -> { field: value }. */
  constructor(factory, anchors = {}) {
    this.factory = factory;
    this.anchors = { ...anchors };
    this.fits = new Map();
  }

  static key(b, s, p, cell) { return `${b}/${s}/${p}/${cell}`; }

  /** Good cells for one ball/spin/power, as [{ cell, values }]. */
  anchorsFor(b, s, p) {
    const prefix = `${comboKey(b, s, p)}/`;
    return Object.entries(this.anchors)
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, values]) => ({ cell: Number(k.slice(prefix.length)), values }));
  }

  fitFor(b, s, p) {
    const ck = comboKey(b, s, p);
    if (!this.fits.has(ck)) {
      const points = this.anchorsFor(b, s, p).flatMap(({ cell, values }) => {
        const f = this.factory.lookup(b, s, p, cell);
        return f ? [{ cell, delta: Object.fromEntries(FIELDS.map((k) => [k, values[k] - f[k]])) }] : [];
      });
      if (points.length) {
        const plane = fitCorrections(points);
        this.fits.set(ck, (cell) => estimateCorrection(points, cell, plane));
      } else {
        this.fits.set(ck, null);
      }
    }
    return this.fits.get(ck);
  }

  /** 'good' (hand-calibrated), 'auto' (estimated from good cells), 'factory', or null (cell not reachable). */
  source(b, s, p, cell) {
    if (!this.factory.lookup(b, s, p, cell)) return null;
    if (this.anchors[Calibration.key(b, s, p, cell)]) return 'good';
    return this.fitFor(b, s, p) ? 'auto' : 'factory';
  }

  /** Drop-in replacement for MotorTable.lookup: what the robot should actually be sent. */
  lookup(b, s, p, cell) {
    const f = this.factory.lookup(b, s, p, cell);
    if (!f) return null;
    const anchor = this.anchors[Calibration.key(b, s, p, cell)];
    if (anchor) return { ...f, ...anchor };
    const fit = this.fitFor(b, s, p);
    if (!fit) return f;
    const corr = fit(cell);
    return { ...f, ...Object.fromEntries(FIELDS.map((k) => [k, clampField(k, f[k] + corr[k])])) };
  }

  setGood(b, s, p, cell, values) {
    this.anchors[Calibration.key(b, s, p, cell)] = Object.fromEntries(FIELDS.map((f) => [f, clampField(f, values[f])]));
    this.fits.delete(comboKey(b, s, p));
  }

  forget(b, s, p, cell) {
    delete this.anchors[Calibration.key(b, s, p, cell)];
    this.fits.delete(comboKey(b, s, p));
  }

  forgetCombo(b, s, p) {
    for (const { cell } of this.anchorsFor(b, s, p)) delete this.anchors[Calibration.key(b, s, p, cell)];
    this.fits.delete(comboKey(b, s, p));
  }

  forgetAll() {
    this.anchors = {};
    this.fits.clear();
  }

  get count() { return Object.keys(this.anchors).length; }

  toJSON() {
    return {
      app: 'tablebot-web',
      kind: 'calibration',
      version: 1,
      savedAt: new Date().toISOString(),
      good: Object.entries(this.anchors).map(([k, v]) => {
        const [ball, spin, power, landarea] = k.split('/').map(Number);
        return { ball, spin, power, landarea, ...v };
      }),
    };
  }

  /**
   * Reads a file saved by toJSON(). Also accepts a full motor table in the Android app's export
   * format (an array of base-conf entries): the entries that differ from factory become good cells.
   */
  static fromJSON(data, factory) {
    let rows;
    if (Array.isArray(data)) {
      rows = data.filter((e) => {
        const f = factory.lookup(e.ball, e.spin, e.power, e.landarea);
        return f && FIELDS.some((k) => e[k] !== f[k]);
      });
    } else if (data && data.kind === 'calibration' && Array.isArray(data.good)) {
      rows = data.good;
    } else {
      throw new Error('Not a calibration file');
    }
    const cal = new Calibration(factory);
    for (const e of rows) {
      if (![e.ball, e.spin, e.power, e.landarea, ...FIELDS.map((f) => e[f])].every(Number.isFinite)) {
        throw new Error('Calibration file has a malformed entry');
      }
      if (factory.lookup(e.ball, e.spin, e.power, e.landarea)) cal.setGood(e.ball, e.spin, e.power, e.landarea, e);
    }
    return cal;
  }
}

/**
 * Which way X moves the ball across the grid, from the factory values: +1 if X rises from
 * column 1 to column 5 (the case in the bundled table), else -1.
 */
export function xDirection(factory, b, s, p) {
  let sum = 0;
  for (let r = 0; r < 3; r++) {
    const left = factory.lookup(b, s, p, r * 5 + 1), right = factory.lookup(b, s, p, r * 5 + 5);
    if (left && right) sum += right.xaxis - left.xaxis;
  }
  return sum < 0 ? -1 : 1;
}

/**
 * One feedback tap -> new values.
 *   long / short: the ball landed past / in front of the target -> both wheels down / up by one.
 *     A wheel at 0 stays at 0, so a no-spin wheel isn't spun up by accident.
 *   left / right: landed to the left / right of the target, as drawn on the grid -> X toward the
 *     other side.
 */
export function nudge(values, action, xDir = 1) {
  const v = { ...values };
  const wheels = (d) => {
    const spinning = ['m1speed', 'm2speed'].filter((f) => v[f] > 0);
    for (const f of spinning.length ? spinning : ['m1speed', 'm2speed']) v[f] = clampField(f, v[f] + d);
  };
  switch (action) {
    case 'long': wheels(-1); break;
    case 'short': wheels(+1); break;
    case 'left': v.xaxis = clampField('xaxis', v.xaxis + xDir); break;
    case 'right': v.xaxis = clampField('xaxis', v.xaxis - xDir); break;
    default: throw new Error(`unknown adjustment: ${action}`);
  }
  return v;
}

export { pick as motorValues };
