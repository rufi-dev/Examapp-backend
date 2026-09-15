/*
 * Optical mark recognition (OMR) for paper answer cards — free, no AI.
 *
 * Finds the A–E bubble grid in a phone photo of the card and measures how filled
 * each bubble is. The card has no corner markers, so the bubbles themselves are
 * the landmarks: circles of one dominant size in regularly spaced rows. Handles
 * a tilted or keystoned photo, an upside-down photo, several bubble blocks side
 * by side, and uneven lighting (ink is measured against the local paper tone).
 *
 * Each row comes back as "marked" (one clear bubble), "blank" or "unclear"
 * (two marks, a faint/partial mark, a cross…); unclear rows are what the caller
 * sends to the AI fallback. Runs OpenCV.js (WASM) in a worker thread so the API
 * event loop never blocks.
 */
const path = require("path");
const { Worker } = require("worker_threads");
const jpeg = require("jpeg-js");

const MAX_DIM = 1600; // photos are analysed at most this large
const EDGE_INK = 70; // darkness (0–255 vs local paper) that outlines a bubble
const FILL_INK = 100; // darkness counted as a pen/pencil mark inside a bubble

// ---- OpenCV loading ----

let cvReady = null;
// Resolves { cv } (wrapped: the Emscripten module can be thenable).
function loadCv() {
  if (!cvReady) {
    cvReady = (async () => {
      const mod = require("@techstark/opencv-js");
      if (mod instanceof Promise) return { cv: await mod };
      if (!mod.Mat) await new Promise((resolve) => (mod.onRuntimeInitialized = resolve));
      return { cv: mod };
    })();
  }
  return cvReady;
}

// ---- small helpers ----

const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const odd = (n) => {
  const k = Math.max(3, Math.round(n));
  return k % 2 ? k : k + 1;
};
// Least squares u = a + b·v over [{u, v}].
function linfit(points) {
  const n = points.length;
  const mv = points.reduce((s, p) => s + p.v, 0) / n;
  const mu = points.reduce((s, p) => s + p.u, 0) / n;
  let cov = 0;
  let varv = 0;
  points.forEach((p) => {
    cov += (p.v - mv) * (p.u - mu);
    varv += (p.v - mv) ** 2;
  });
  const b = varv > 1e-6 ? cov / varv : 0;
  return { a: mu - b * mv, b };
}
// Chain items sorted by `key` into groups whose consecutive gap is < tol.
function chainBy(items, key, tol) {
  const groups = [];
  [...items]
    .sort((a, b) => a[key] - b[key])
    .forEach((p) => {
      const g = groups[groups.length - 1];
      if (g && p[key] - g.last < tol) {
        g.pts.push(p);
        g.last = p[key];
      } else groups.push({ pts: [p], last: p[key] });
    });
  return groups;
}

// ---- image → ink map ----

// Darkness of every pixel relative to the local paper brightness (0 = paper,
// 255 = black ink). Shadows, a tinted table, coloured columns and uneven light
// all cancel out; only marks darker than their surroundings remain.
function inkMap(cv, gray, keep) {
  const W = gray.cols;
  const H = gray.rows;
  const f = 0.25;
  const sw = Math.max(8, Math.round(W * f));
  const sh = Math.max(8, Math.round(H * f));
  const small = keep(new cv.Mat());
  cv.resize(gray, small, new cv.Size(sw, sh), 0, 0, cv.INTER_AREA);
  const k = odd(Math.max(sw, sh) * 0.08); // wider than any bubble
  const kernel = keep(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(k, k)));
  const closed = keep(new cv.Mat());
  cv.morphologyEx(small, closed, cv.MORPH_CLOSE, kernel); // removes dark strokes → paper tone
  const blurred = keep(new cv.Mat());
  cv.GaussianBlur(closed, blurred, new cv.Size(k, k), 0);
  const bg = keep(new cv.Mat());
  cv.resize(blurred, bg, new cv.Size(W, H), 0, 0, cv.INTER_LINEAR);
  const g = gray.data;
  const b = bg.data;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < out.length; i++) {
    const v = 255 - (g[i] * 255) / Math.max(b[i], 40);
    out[i] = v <= 0 ? 0 : v >= 255 ? 255 : v;
  }
  return out;
}

// Round, solid-outlined shapes → bubble candidates { x, y, d }.
function detectCircles(cv, ink, W, H, keep) {
  const bin = keep(new cv.Mat(H, W, cv.CV_8UC1));
  const bd = bin.data;
  for (let i = 0; i < ink.length; i++) bd[i] = ink[i] > EDGE_INK ? 255 : 0;
  const contours = keep(new cv.MatVector());
  const hier = keep(new cv.Mat());
  cv.findContours(bin, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
  const D = Math.max(W, H);
  const out = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    try {
      const r = cv.boundingRect(c);
      const d = (r.width + r.height) / 2;
      const aspect = r.width / r.height;
      if (d < D * 0.01 || d > D * 0.08 || aspect < 0.72 || aspect > 1.38) continue;
      const area = cv.contourArea(c);
      const per = cv.arcLength(c, true);
      const circularity = per > 0 ? (4 * Math.PI * area) / (per * per) : 0;
      const fill = area / (Math.PI * (d / 2) ** 2);
      // Squares (table cells) fill ~1.27 of their inscribed circle; bubbles ~1.
      if (circularity > 0.7 && fill > 0.8 && fill < 1.12) out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, d });
    } finally {
      c.delete();
    }
  }
  return out;
}

// ---- candidates → bubble grid ----

function locateGrid(cands, options) {
  const fail = (reason) => ({ ok: false, reason });
  if (cands.length < options * 3) return fail("few_circles");

  // Dominant bubble size; merge the inner/outer outlines of one printed ring.
  let d0 = 0;
  let bestN = 0;
  cands.forEach((c) => {
    let n = 0;
    cands.forEach((o) => {
      if (Math.abs(o.d - c.d) <= 0.15 * c.d) n++;
    });
    if (n > bestN) {
      bestN = n;
      d0 = c.d;
    }
  });
  const merged = [];
  cands
    .filter((c) => c.d >= 0.7 * d0 && c.d <= 1.45 * d0)
    .sort((a, b) => b.d - a.d)
    .forEach((p) => {
      if (!merged.some((m) => Math.hypot(m.x - p.x, m.y - p.y) < 0.45 * m.d)) merged.push(p);
    });
  if (merged.length < options * 3) return fail("few_circles");
  d0 = median(merged.map((p) => p.d));

  // Grid rotation from nearest-neighbour directions (mod 90°).
  let sx = 0;
  let sy = 0;
  merged.forEach((p) => {
    let best = Infinity;
    let bv = null;
    merged.forEach((q) => {
      if (q === p) return;
      const dd = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (dd < best) {
        best = dd;
        bv = [q.x - p.x, q.y - p.y];
      }
    });
    if (bv && Math.sqrt(best) < 2.5 * d0) {
      const a = Math.atan2(bv[1], bv[0]);
      sx += Math.cos(4 * a);
      sy += Math.sin(4 * a);
    }
  });
  const theta = Math.atan2(sy, sx) / 4;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const P = merged.map((p) => ({ ...p, u: p.x * cos + p.y * sin, v: -p.x * sin + p.y * cos }));

  // Horizontal runs of `options` evenly spaced bubbles = answer rows.
  const groups = chainBy(P, "v", 0.5 * d0);
  const gaps = [];
  groups.forEach((g) => {
    g.pts.sort((a, b) => a.u - b.u);
    for (let i = 1; i < g.pts.length; i++) {
      const gp = g.pts[i].u - g.pts[i - 1].u;
      if (gp > 1.05 * d0 && gp < 2.3 * d0) gaps.push(gp);
    }
  });
  if (gaps.length < options) return fail("no_grid");
  const pu = median(gaps);
  const runs = [];
  let long = 0;
  groups.forEach((g) => {
    let run = [g.pts[0]];
    const flush = () => {
      if (run.length === options) runs.push(run);
      else if (run.length > options) long++;
    };
    for (let i = 1; i < g.pts.length; i++) {
      if (Math.abs(g.pts[i].u - g.pts[i - 1].u - pu) <= 0.25 * pu) run.push(g.pts[i]);
      else {
        flush();
        run = [g.pts[i]];
      }
    }
    flush();
  });
  if (runs.length < 3 || long > runs.length) return fail(long ? "rotated" : "no_grid");

  // Runs starting at the same place form one block (cards may have several).
  const clusters = chainBy(
    runs.map((r) => ({ r, u: r[0].u })),
    "u",
    0.8 * pu
  ).filter((c) => c.pts.length >= 3);
  if (!clusters.length) return fail("no_grid");

  const blocks = [];
  clusters.forEach((cl) => {
    const blockRuns = cl.pts.map((x) => x.r);
    const lines = Array.from({ length: options }, (_, c) => linfit(blockRuns.map((r) => r[c])));
    const predU = (c, v) => lines[c].a + lines[c].b * v;

    // Every bubble near one of this block's column lines.
    const assigned = [];
    P.forEach((p) => {
      let bestC = -1;
      let bestE = Infinity;
      for (let c = 0; c < options; c++) {
        const e = Math.abs(p.u - predU(c, p.v));
        if (e < bestE) {
          bestE = e;
          bestC = c;
        }
      }
      if (bestE < 0.3 * pu) assigned.push({ ...p, c: bestC });
    });
    const rows = chainBy(assigned, "v", 0.5 * d0)
      .filter((g) => new Set(g.pts.map((p) => p.c)).size >= Math.min(3, options))
      .map((g) => ({ v: median(g.pts.map((p) => p.v)), pts: g.pts }));
    if (rows.length < 3) return;

    // Keep the longest evenly spaced chain of rows; fill in up to two missing rows.
    const diffs = [];
    for (let i = 1; i < rows.length; i++) diffs.push(rows[i].v - rows[i - 1].v);
    const pv = median(diffs.filter((d) => d > 1.0 * d0 && d < 2.2 * d0)) || pu;
    const chains = [];
    let chain = [rows[0]];
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i].v - rows[i - 1].v;
      const k = Math.round(gap / pv);
      if (k >= 1 && k <= 3 && Math.abs(gap - k * pv) <= 0.3 * pv) {
        for (let j = 1; j < k; j++) chain.push({ v: rows[i - 1].v + (j * gap) / k, pts: [], virtual: true });
        chain.push(rows[i]);
      } else {
        chains.push(chain);
        chain = [rows[i]];
      }
    }
    chains.push(chain);
    const realCount = (ch) => ch.filter((r) => !r.virtual).length;
    const best = chains.reduce((a, ch) => (realCount(ch) > realCount(a) ? ch : a));
    if (realCount(best) < 3) return;

    // Cell centres: column line × the row's own (possibly tilted) line.
    const cells = best.map((row) => {
      let rowFit = null;
      if (row.pts.length >= 2 && new Set(row.pts.map((p) => p.c)).size >= 2) {
        rowFit = linfit(row.pts.map((p) => ({ u: p.v, v: p.u }))); // v = a + b·u
      }
      return Array.from({ length: options }, (_, c) => {
        let v = row.v;
        let u = predU(c, v);
        if (rowFit) {
          v = rowFit.a + rowFit.b * u;
          u = predU(c, v);
        }
        return { u, v };
      });
    });
    blocks.push({ cells, lines, uStart: median(blockRuns.map((r) => r[0].u)) });
  });
  if (!blocks.length) return fail("no_grid");
  blocks.sort((a, b) => a.uStart - b.uStart);

  const toXY = ({ u, v }) => ({ x: u * cos - v * sin, y: u * sin + v * cos });
  return { ok: true, d0, pu, theta, blocks, toXY };
}

// Share of a disk that is inked.
function diskInk(ink, W, H, x, y, r) {
  let n = 0;
  let dark = 0;
  let sum = 0;
  const r2 = r * r;
  const x0 = Math.max(0, Math.floor(x - r));
  const x1 = Math.min(W - 1, Math.ceil(x + r));
  const y0 = Math.max(0, Math.floor(y - r));
  const y1 = Math.min(H - 1, Math.ceil(y + r));
  for (let yy = y0; yy <= y1; yy++) {
    for (let xx = x0; xx <= x1; xx++) {
      if ((xx - x) ** 2 + (yy - y) ** 2 > r2) continue;
      const v = ink[yy * W + xx];
      n++;
      sum += v;
      if (v > FILL_INK) dark++;
    }
  }
  return { frac: n ? dark / n : 0, mean: n ? sum / n : 0 };
}

// Upside-down check: printed row numbers sit LEFT of the first column; right of
// the last column is empty paper.
function looksFlipped(grid, ink, W, H) {
  const first = grid.blocks[0];
  const last = grid.blocks[grid.blocks.length - 1];
  const r = 0.3 * grid.pu;
  let left = 0;
  let right = 0;
  first.cells.forEach((row) => {
    const p = grid.toXY({ u: row[0].u - grid.pu, v: row[0].v });
    left += diskInk(ink, W, H, p.x, p.y, r).mean;
  });
  last.cells.forEach((row) => {
    const p = grid.toXY({ u: row[row.length - 1].u + grid.pu, v: row[row.length - 1].v });
    right += diskInk(ink, W, H, p.x, p.y, r).mean;
  });
  left /= first.cells.length;
  right /= last.cells.length;
  return right > left * 1.5 + 3;
}

// ---- main ----

function analyzeImage(cv, img, { options = 5 } = {}) {
  const mats = [];
  const keep = (m) => {
    mats.push(m);
    return m;
  };
  try {
    const rgba = keep(cv.matFromImageData(img));
    let gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const scale = Math.min(1, MAX_DIM / Math.max(gray.cols, gray.rows));
    if (scale < 1) {
      const g = keep(new cv.Mat());
      cv.resize(gray, g, new cv.Size(Math.round(gray.cols * scale), Math.round(gray.rows * scale)), 0, 0, cv.INTER_AREA);
      gray = g;
    }
    const W = gray.cols;
    const H = gray.rows;
    const ink = inkMap(cv, gray, keep);
    const cands = detectCircles(cv, ink, W, H, keep);
    const base = { width: img.width, height: img.height };

    let grid = locateGrid(cands, options);
    if (!grid.ok) return { ok: false, reason: grid.reason, ...base };
    let flipped = false;
    if (looksFlipped(grid, ink, W, H)) {
      flipped = true;
      grid = locateGrid(
        cands.map((c) => ({ ...c, x: W - 1 - c.x, y: H - 1 - c.y })),
        options
      );
      if (!grid.ok) return { ok: false, reason: grid.reason, ...base };
    }
    // Upright coordinates → analysed-image pixels.
    const px = (x, y) => (flipped ? [W - 1 - x, H - 1 - y] : [x, y]);

    const rr = 0.3 * grid.d0;
    const rows = [];
    grid.blocks.forEach((block) => {
      block.cells.forEach((row) => {
        const centers = row.map((cell) => grid.toXY(cell));
        const fracs = centers.map(({ x, y }) => {
          const [ax, ay] = px(x, y);
          return diskInk(ink, W, H, ax, ay, rr).frac;
        });
        rows.push({ centers, fracs });
      });
    });

    // Printed letters inside empty bubbles carry some ink. Baseline per column =
    // its typical empty level (never above the sheet-wide empty level, so a
    // letter most students chose doesn't hide its own marks).
    const all = median(rows.flatMap((r) => r.fracs));
    const baseline = Array.from({ length: options }, (_, c) =>
      Math.min(median(rows.map((r) => r.fracs[c])), all + 0.06)
    );

    const out = rows.map(({ centers, fracs }) => {
      const scores = fracs.map((f, c) => Math.max(0, f - baseline[c]));
      const order = scores.map((s, c) => ({ s, c })).sort((a, b) => b.s - a.s);
      const [s1, s2] = [order[0].s, order[1] ? order[1].s : 0];
      let status;
      let col = -1;
      let note = "";
      if (s1 >= 0.35 && s2 < 0.18 && s1 - s2 >= 0.25) {
        status = "marked";
        col = order[0].c;
      } else if (s1 < 0.12) {
        status = "blank";
      } else {
        status = "unclear";
        note = s2 >= 0.18 ? "iki variant işarələnib" : "işarə aydın deyil";
      }
      return {
        status,
        col,
        note,
        scores: scores.map((s) => Math.round(s * 100) / 100),
        centers: centers.map(({ x, y }) => [Math.round(x / scale), Math.round(y / scale)]),
      };
    });

    const pts = out.flatMap((r) => r.centers);
    const pad = grid.d0 / scale;
    return {
      ok: true,
      flipped,
      theta: Math.round((grid.theta * 180) / Math.PI * 10) / 10,
      blocks: grid.blocks.length,
      bubble: Math.round(grid.d0 / scale),
      pitch: Math.round(grid.pu / scale),
      // Grid bounds in UPRIGHT coordinates of the original image.
      grid: {
        x0: Math.min(...pts.map((p) => p[0])) - pad,
        y0: Math.min(...pts.map((p) => p[1])) - pad,
        x1: Math.max(...pts.map((p) => p[0])) + pad,
        y1: Math.max(...pts.map((p) => p[1])) + pad,
      },
      rows: out,
      ...base,
    };
  } finally {
    mats.forEach((m) => {
      try {
        m.delete();
      } catch {
        /* already freed */
      }
    });
  }
}

async function analyzeJpeg(buffer, opts) {
  const { cv } = await loadCv();
  const img = jpeg.decode(buffer, {
    useTArray: true,
    formatAsRGBA: true,
    maxMemoryUsageInMB: 1024,
    maxResolutionInMP: 80,
  });
  return analyzeImage(cv, img, opts);
}

// ---- worker pool (one worker, reused; freed after idle) ----

const IDLE_MS = 5 * 60 * 1000;
let worker = null;
let seq = 0;
let idleTimer = null;
const pending = new Map();

function killWorker(err) {
  const w = worker;
  worker = null;
  pending.forEach((p) => {
    clearTimeout(p.timer);
    p.reject(err);
  });
  pending.clear();
  if (w) w.terminate().catch(() => {});
}

function getWorker() {
  if (worker) return worker;
  const w = new Worker(path.join(__dirname, "sheetOmrWorker.js"));
  w.on("message", ({ id, result, error }) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
    if (!pending.size) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!pending.size && worker === w) killWorker(new Error("idle"));
      }, IDLE_MS);
      idleTimer.unref?.();
    }
  });
  w.on("error", (e) => worker === w && killWorker(e));
  w.on("exit", (code) => worker === w && killWorker(new Error(`OMR worker exited (${code})`)));
  w.unref();
  worker = w;
  return w;
}

// Analyse one JPEG photo in the worker → the analyzeImage result.
function runOmr(buffer, opts = {}, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    clearTimeout(idleTimer);
    const timer = setTimeout(() => killWorker(new Error("OMR vaxtı bitdi")), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, buffer, opts });
  });
}

module.exports = { runOmr, analyzeJpeg, analyzeImage, loadCv, _internals: { inkMap, detectCircles, locateGrid } };
