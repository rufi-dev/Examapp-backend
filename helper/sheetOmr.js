/*
 * Optical mark recognition (OMR) for paper answer cards — free, no AI.
 *
 * Finds the A–E bubble grid in a phone photo of the card and measures how filled
 * each bubble is. The card has no corner markers, so the bubbles themselves are
 * the landmarks: circles of one dominant size in regularly spaced rows. Handles
 * a tilted or keystoned photo, an upside-down photo, several bubble blocks side
 * by side, uneven lighting (ink is measured against the local paper tone) and
 * cards printed in red (marks are then measured in the red channel, where the
 * printed rings and letters vanish and pen/pencil stays dark).
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
      // (blurred small squares creep down toward ~1.1, printed rings sit at ~0.92–0.96)
      if (circularity > 0.75 && fill > 0.8 && fill < 1.08) {
        out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2, d, circularity, fill });
      }
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
    .filter((c) => c.d >= 0.75 * d0 && c.d <= 1.3 * d0)
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
    if (bv && Math.sqrt(best) < 4 * d0) {
      const a = Math.atan2(bv[1], bv[0]);
      sx += Math.cos(4 * a);
      sy += Math.sin(4 * a);
    }
  });
  const theta = Math.atan2(sy, sx) / 4;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const P = merged.map((p) => ({ ...p, u: p.x * cos + p.y * sin, v: -p.x * sin + p.y * cos }));

  // Horizontal runs of `options` evenly spaced bubbles = answer rows. Cards space
  // columns anywhere from ~1.4 to ~3.5 bubble widths apart.
  const groups = chainBy(P, "v", 0.5 * d0);
  const gaps = [];
  groups.forEach((g) => {
    g.pts.sort((a, b) => a.u - b.u);
    for (let i = 1; i < g.pts.length; i++) {
      const gp = g.pts[i].u - g.pts[i - 1].u;
      if (gp > 1.05 * d0 && gp < 4 * d0) gaps.push(gp);
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
  if (process.env.OMR_DEBUG) {
    console.log("[omr] d0", d0.toFixed(1), "pu", pu.toFixed(1), "θ", ((theta * 180) / Math.PI).toFixed(1), "runs", runs.length, "long", long,
      "groups", groups.map((g) => g.pts.length).join(","));
  }
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
      if (bestE < Math.min(0.3 * pu, 0.6 * d0)) assigned.push({ ...p, c: bestC });
    });
    const rows = chainBy(assigned, "v", 0.5 * d0)
      .filter((g) => new Set(g.pts.map((p) => p.c)).size >= Math.min(3, options))
      .map((g) => ({ v: median(g.pts.map((p) => p.v)), pts: g.pts }));
    if (rows.length < 3) return;

    // Keep the longest evenly spaced chain of rows; fill in up to two missing rows.
    const diffs = [];
    for (let i = 1; i < rows.length; i++) diffs.push(rows[i].v - rows[i - 1].v);
    const pv = median(diffs.filter((d) => d > 1.0 * d0 && d < 4 * d0)) || pu;
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
    blocks.push({ cells, lines, pv, uStart: median(blockRuns.map((r) => r[0].u)) });
  });
  if (!blocks.length) return fail("no_grid");
  blocks.sort((a, b) => a.uStart - b.uStart);

  const toXY = ({ u, v }) => ({ x: u * cos - v * sin, y: u * sin + v * cos });
  return { ok: true, d0, pu, theta, blocks, toXY };
}

// Share of a disk that is inked (+ its mean darkness).
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

// Upside-down check. On an upright card the printed row numbers sit LEFT of the
// first column (right of the last is paper or a divider) and the column header /
// section title sits ABOVE the first row (below the last row is paper).
function orientationScore(grid, ink, W, H) {
  const sample = (u, v, r) => {
    const p = grid.toXY({ u, v });
    return diskInk(ink, W, H, p.x, p.y, r).mean;
  };
  let side = 0;
  let sideN = 0;
  let vert = 0;
  let vertN = 0;
  grid.blocks.forEach((b) => {
    const r = 0.3 * Math.min(grid.pu, b.pv);
    b.cells.forEach((row) => {
      const a = row[0];
      const z = row[row.length - 1];
      side += sample(a.u - grid.pu, a.v, r) - sample(z.u + grid.pu, z.v, r);
      sideN++;
    });
    const first = b.cells[0];
    const last = b.cells[b.cells.length - 1];
    first.forEach((cell, c) => {
      vert += sample(cell.u, cell.v - b.pv, r) - sample(last[c].u, last[c].v + b.pv, r);
      vertN++;
    });
  });
  return (sideN ? side / sideN : 0) + (vertN ? vert / vertN : 0);
}

// Per-row decision from bubble fill shares. Printed letters inside empty bubbles
// carry some ink: baseline per column = its typical empty level (never above the
// sheet-wide empty level, so a letter most students chose doesn't hide its marks).
function decideRows(fracRows, options) {
  const all = median(fracRows.flat());
  const baseline = Array.from({ length: options }, (_, c) =>
    Math.min(median(fracRows.map((r) => r[c])), all + 0.06)
  );
  return fracRows.map((fracs) => {
    const scores = fracs.map((f, c) => Math.max(0, f - baseline[c]));
    const order = scores.map((s, c) => ({ s, c })).sort((a, b) => b.s - a.s);
    const s1 = order[0].s;
    const s2 = order[1] ? order[1].s : 0;
    if (s1 >= 0.35 && s2 < 0.18 && s1 - s2 >= 0.25) return { status: "marked", col: order[0].c, note: "", scores };
    // Empty bubbles score ~0–0.04; anything more (a thin cross, a light tick) is
    // left for the AI rather than silently treated as blank.
    if (s1 < 0.08) return { status: "blank", col: -1, note: "", scores };
    return {
      status: "unclear",
      col: -1,
      note: s2 >= 0.18 ? "iki variant işarələnib" : "işarə aydın deyil",
      scores,
    };
  });
}

// ---- main ----

function analyzeImage(cv, img, { options = 5 } = {}) {
  const mats = [];
  const keep = (m) => {
    mats.push(m);
    return m;
  };
  try {
    let rgba = keep(cv.matFromImageData(img));
    const scale = Math.min(1, MAX_DIM / Math.max(rgba.cols, rgba.rows));
    if (scale < 1) {
      const r = keep(new cv.Mat());
      cv.resize(rgba, r, new cv.Size(Math.round(rgba.cols * scale), Math.round(rgba.rows * scale)), 0, 0, cv.INTER_AREA);
      rgba = r;
    }
    const W = rgba.cols;
    const H = rgba.rows;
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const ink = inkMap(cv, gray, keep);
    const cands = detectCircles(cv, ink, W, H, keep);
    const base = { width: img.width, height: img.height };

    let grid = locateGrid(cands, options);
    if (!grid.ok) return { ok: false, reason: grid.reason, ...base };
    const orientation = orientationScore(grid, ink, W, H);
    const flipped = orientation < -4;
    if (flipped) {
      grid = locateGrid(
        cands.map((c) => ({ ...c, x: W - 1 - c.x, y: H - 1 - c.y })),
        options
      );
      if (!grid.ok) return { ok: false, reason: grid.reason, ...base };
    }
    // Upright coordinates → analysed-image pixels.
    const at = (x, y) => (flipped ? [W - 1 - x, H - 1 - y] : [x, y]);

    const centerRows = grid.blocks.flatMap((block) => block.cells.map((row) => row.map((cell) => grid.toXY(cell))));

    // Colour-printed card? Sample the printed rings: red rings → measure marks in
    // the red channel, where red print disappears and pen/pencil stays dark.
    const px = rgba.data;
    let redDiff = 0;
    let redN = 0;
    const ringR = 0.47 * grid.d0;
    centerRows.forEach((row) =>
      row.forEach(({ x, y }) => {
        for (let k = 0; k < 16; k++) {
          const [ax, ay] = at(x + ringR * Math.cos((k * Math.PI) / 8), y + ringR * Math.sin((k * Math.PI) / 8));
          const xi = Math.round(ax);
          const yi = Math.round(ay);
          if (xi < 0 || yi < 0 || xi >= W || yi >= H) continue;
          const i = yi * W + xi;
          if (ink[i] <= EDGE_INK) continue;
          redDiff += px[i * 4] - px[i * 4 + 1];
          redN++;
        }
      })
    );
    const redPrint = redN > 40 && redDiff / redN > 45;

    const rr = 0.3 * grid.d0;
    const measure = (map) =>
      centerRows.map((row) =>
        row.map(({ x, y }) => {
          const [ax, ay] = at(x, y);
          return diskInk(map, W, H, ax, ay, rr).frac;
        })
      );
    let decided;
    if (redPrint) {
      const red = keep(new cv.Mat(H, W, cv.CV_8UC1));
      const rd = red.data;
      for (let i = 0; i < rd.length; i++) rd[i] = px[i * 4];
      const byRed = decideRows(measure(inkMap(cv, red, keep)), options);
      const byGray = decideRows(measure(ink), options);
      // A mark visible in gray but not in red = drawn in red/pink pen: ask AI.
      decided = byRed.map((row, i) =>
        row.status === "blank" && byGray[i].status !== "blank"
          ? { ...row, status: "unclear", note: "rəngli qələmlə işarələnib ola bilər" }
          : row
      );
    } else {
      decided = decideRows(measure(ink), options);
    }

    const rows = decided.map((row, i) => ({
      status: row.status,
      col: row.col,
      note: row.note,
      scores: row.scores.map((s) => Math.round(s * 100) / 100),
      centers: centerRows[i].map(({ x, y }) => [Math.round(x / scale), Math.round(y / scale)]),
    }));
    const pts = rows.flatMap((r) => r.centers);
    const pad = grid.d0 / scale;
    return {
      ok: true,
      flipped,
      redPrint,
      orientation: Math.round(orientation * 10) / 10,
      theta: Math.round(((grid.theta * 180) / Math.PI) * 10) / 10,
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
      rows,
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

// ---- handwriting punctuation check ----

const GLYPH_INK = 90;

/*
 * OCR reads handwritten digits well but can drop thin marks between them — a
 * fraction slash ("7/5" → "75"), a decimal dot, a leading minus. For each answer
 * (its OCR characters with boxes, in upright coordinates) look at the actual ink:
 * a stroke no recognised character accounts for is classified as "/" (tall,
 * rising diagonal), "." (small blob near the baseline) or "-" (short flat dash
 * before the number) and inserted by position.
 *   rows: [{ symbols: [{ text, x0, x1, y0, y1 }] }]  →  [{ text, added: [char] } | null]
 */
function analyzeGlyphsImage(cv, img, { flipped = false, rows = [], debug = false } = {}) {
  const mats = [];
  const keep = (m) => {
    mats.push(m);
    return m;
  };
  try {
    const rgba = keep(cv.matFromImageData(img));
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const W = gray.cols;
    const H = gray.rows;
    const ink = inkMap(cv, gray, keep);

    return rows.map((row) => {
      const syms = (row?.symbols || []).filter((s) => s.x1 > s.x0 && s.y1 > s.y0);
      if (!syms.length) return null;
      const hs = median(syms.map((s) => s.y1 - s.y0)) || 1;
      const textTop = Math.min(...syms.map((s) => s.y0));
      const textBot = Math.max(...syms.map((s) => s.y1));
      const firstX = Math.min(...syms.map((s) => s.x0));
      const ux0 = firstX - 0.6 * hs;
      const ux1 = Math.max(...syms.map((s) => s.x1)) + 0.6 * hs;
      const uy0 = textTop - 0.35 * hs;
      const uy1 = textBot + 0.35 * hs;
      const px0 = Math.max(0, Math.floor(flipped ? W - 1 - ux1 : ux0));
      const px1 = Math.min(W - 1, Math.ceil(flipped ? W - 1 - ux0 : ux1));
      const py0 = Math.max(0, Math.floor(flipped ? H - 1 - uy1 : uy0));
      const py1 = Math.min(H - 1, Math.ceil(flipped ? H - 1 - uy0 : uy1));
      const cw = px1 - px0 + 1;
      const chh = py1 - py0 + 1;
      const plain = { text: syms.map((s) => s.text).join(""), added: [] };
      if (cw < 4 || chh < 4) return plain;

      const bin = keep(new cv.Mat(chh, cw, cv.CV_8UC1));
      const bd = bin.data;
      for (let y = 0; y < chh; y++) {
        for (let x = 0; x < cw; x++) bd[y * cw + x] = ink[(py0 + y) * W + px0 + x] > GLYPH_INK ? 255 : 0;
      }
      // Erase the answer box's printed border (long straight runs): handwriting that
      // touches the border would otherwise merge with it into one big blob.
      const eraseRuns = (len, lines, along, at) => {
        for (let a = 0; a < lines; a++) {
          let start = -1;
          for (let b = 0; b <= along; b++) {
            const on = b < along && bd[at(a, b)];
            if (on && start < 0) start = b;
            if (!on && start >= 0) {
              if (b - start >= len) for (let k = start; k < b; k++) bd[at(a, k)] = 0;
              start = -1;
            }
          }
        }
      };
      eraseRuns(Math.max(12, Math.round(2 * hs)), chh, cw, (y, x) => y * cw + x); // horizontal
      eraseRuns(Math.max(12, Math.round(1.8 * hs)), cw, chh, (x, y) => y * cw + x); // vertical
      const labels = keep(new cv.Mat());
      const stats = keep(new cv.Mat());
      const cents = keep(new cv.Mat());
      const n = cv.connectedComponentsWithStats(bin, labels, stats, cents, 8, cv.CV_32S);
      const st = stats.data32S;
      const lb = labels.data32S;
      const up = (x, y) => (flipped ? [W - 1 - (px0 + x), H - 1 - (py0 + y)] : [px0 + x, py0 + y]);

      const added = [];
      const comps = [];
      for (let i = 1; i < n; i++) {
        const l = st[i * 5];
        const t = st[i * 5 + 1];
        const w = st[i * 5 + 2];
        const h = st[i * 5 + 3];
        const area = st[i * 5 + 4];
        if (area < Math.max(4, 0.01 * hs * hs)) continue; // speckle
        if (w > 3 * hs || h > 2 * hs) continue; // box border / underline
        const [ax, ay] = up(l, t);
        const [bx, by] = up(l + w - 1, t + h - 1);
        const cx = (ax + bx) / 2;
        const cy = (ay + by) / 2;
        // Part of a character OCR already read?
        const owner = syms.find((s) => cx > s.x0 + 0.15 * (s.x1 - s.x0) && cx < s.x1 - 0.15 * (s.x1 - s.x0));
        if (debug) comps.push({ x0: Math.min(ax, bx), x1: Math.max(ax, bx), y0: Math.min(ay, by), y1: Math.max(ay, by), w, h, area, owner: owner?.text || null });
        if (owner) continue;

        let char = null;
        const rel = (cy - textTop) / Math.max(1, textBot - textTop);
        if (w <= 0.4 * hs && h <= 0.4 * hs && rel > 0.55) {
          char = ".";
        } else if (h >= 0.55 * hs && w <= 1.1 * h) {
          let k = 0;
          let sx = 0;
          let sy = 0;
          let sxx = 0;
          let syy = 0;
          let sxy = 0;
          for (let y = t; y < t + h; y++) {
            for (let x = l; x < l + w; x++) {
              if (lb[y * cw + x] !== i) continue;
              const [X, Y] = up(x, y);
              k++;
              sx += X;
              sy += Y;
              sxx += X * X;
              syy += Y * Y;
              sxy += X * Y;
            }
          }
          const vx = sxx / k - (sx / k) ** 2;
          const vy = syy / k - (sy / k) ** 2;
          const corr = vx > 0 && vy > 0 ? (sxy / k - (sx / k) * (sy / k)) / Math.sqrt(vx * vy) : 0;
          if (debug) comps[comps.length - 1].corr = Math.round(corr * 100) / 100;
          if (corr < -0.6) char = "/"; // rises left → right
        } else if (h <= 0.3 * hs && w >= 0.35 * hs && rel > 0.25 && rel < 0.8 && cx < firstX) {
          char = "-";
        }
        if (!char) continue;
        if (syms.some((s) => s.text === char && Math.abs((s.x0 + s.x1) / 2 - cx) < 0.6 * hs)) continue;
        added.push({ char, cx });
      }
      if (debug) plain.comps = comps;
      if (!added.length) return plain;
      const text = [
        ...syms.map((s) => ({ t: s.text, cx: (s.x0 + s.x1) / 2 })),
        ...added.map((a) => ({ t: a.char, cx: a.cx })),
      ]
        .sort((a, b) => a.cx - b.cx)
        .map((x) => x.t)
        .join("");
      return { text, added: added.map((a) => a.char) };
    });
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

/*
 * How much handwriting sits inside given boxes (upright coordinates).
 *
 * OCR returning no words does not prove a box is empty: faint pencil, glare,
 * cursive or a bad crop all read as nothing. This measures the box's own ink
 * after erasing the printed border lines, so "blank" can be evidence-based.
 *   boxes: [{ x0, y0, x1, y1 } | null]  →  [{ ink, pixels } | null]
 */
function analyzeBoxInkImage(cv, img, { flipped = false, boxes = [] } = {}) {
  const mats = [];
  const keep = (m) => {
    mats.push(m);
    return m;
  };
  try {
    const rgba = keep(cv.matFromImageData(img));
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const W = gray.cols;
    const H = gray.rows;
    const ink = inkMap(cv, gray, keep);

    return boxes.map((b) => {
      if (!b || !(b.x1 > b.x0) || !(b.y1 > b.y0)) return null;
      const px0 = Math.max(0, Math.floor(flipped ? W - 1 - b.x1 : b.x0));
      const px1 = Math.min(W - 1, Math.ceil(flipped ? W - 1 - b.x0 : b.x1));
      const py0 = Math.max(0, Math.floor(flipped ? H - 1 - b.y1 : b.y0));
      const py1 = Math.min(H - 1, Math.ceil(flipped ? H - 1 - b.y0 : b.y1));
      const cw = px1 - px0 + 1;
      const chh = py1 - py0 + 1;
      if (cw < 4 || chh < 4) return null;

      const bin = keep(new cv.Mat(chh, cw, cv.CV_8UC1));
      const bd = bin.data;
      for (let y = 0; y < chh; y++) {
        for (let x = 0; x < cw; x++) bd[y * cw + x] = ink[(py0 + y) * W + px0 + x] > GLYPH_INK ? 255 : 0;
      }
      // Erase the printed box rules; only handwriting should remain.
      const runs = (len, lines, along, at) => {
        for (let a = 0; a < lines; a++) {
          let start = -1;
          for (let c = 0; c <= along; c++) {
            const on = c < along && bd[at(a, c)];
            if (on && start < 0) start = c;
            if (!on && start >= 0) {
              if (c - start >= len) for (let k = start; k < c; k++) bd[at(a, k)] = 0;
              start = -1;
            }
          }
        }
      };
      runs(Math.max(12, Math.round(cw * 0.5)), chh, cw, (y, x) => y * cw + x);
      runs(Math.max(12, Math.round(chh * 0.6)), cw, chh, (x, y) => y * cw + x);

      let dark = 0;
      for (let i = 0; i < bd.length; i++) if (bd[i]) dark++;
      return { ink: dark / (cw * chh), pixels: dark };
    });
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

async function analyzeBoxInkJpeg(buffer, opts) {
  const { cv } = await loadCv();
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 80 });
  return analyzeBoxInkImage(cv, img, opts);
}

async function analyzeGlyphsJpeg(buffer, opts) {
  const { cv } = await loadCv();
  const img = jpeg.decode(buffer, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 80 });
  return analyzeGlyphsImage(cv, img, opts);
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

function runInWorker(kind, buffer, opts, timeoutMs) {
  return new Promise((resolve, reject) => {
    const w = getWorker();
    const id = ++seq;
    clearTimeout(idleTimer);
    const timer = setTimeout(() => killWorker(new Error("OMR vaxtı bitdi")), timeoutMs);
    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, kind, buffer, opts });
  });
}

// Bubble grid of one JPEG photo → the analyzeImage result.
const runOmr = (buffer, opts = {}, timeoutMs = 45000) => runInWorker("omr", buffer, opts, timeoutMs);
// Punctuation check of OCR'd answers on one JPEG photo → analyzeGlyphsImage result.
const runGlyphs = (buffer, opts = {}, timeoutMs = 30000) => runInWorker("glyphs", buffer, opts, timeoutMs);
// Ink inside answer boxes → analyzeBoxInkImage result (evidence for "blank").
const runBoxInk = (buffer, opts = {}, timeoutMs = 30000) => runInWorker("boxink", buffer, opts, timeoutMs);

module.exports = {
  runOmr,
  runGlyphs,
  runBoxInk,
  analyzeJpeg,
  analyzeImage,
  analyzeGlyphsJpeg,
  analyzeBoxInkJpeg,
  analyzeBoxInkImage,
  loadCv,
  _internals: { inkMap, detectCircles, locateGrid },
};
