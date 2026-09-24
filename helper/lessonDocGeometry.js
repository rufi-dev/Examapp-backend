/*
 * Figures, drawn to scale.
 *
 * A teacher asked for the Pythagoras diagram — a right triangle with the squares
 * built on its three sides — and got eight rounded boxes in two columns, because
 * the only shapes the engine could draw were boxes, arrows and bars. Asked a
 * second time, in plainer words, it drew the same boxes. That is the worst kind
 * of failure this feature has: it produced something, so nothing looked broken,
 * and the material was simply wrong.
 *
 * What makes these figures worth having is that they are CONSTRUCTED, not
 * illustrated. A 3-4-5 triangle is built from the numbers 3, 4 and 5 and then
 * fitted to the page, so its right angle is a right angle and its hypotenuse is
 * visibly the longest side. A pupil can measure it. The alternative — a generic
 * triangle picture with the teacher's numbers written beside it — teaches a
 * shape that does not match its own labels, which is worse than no picture.
 *
 * The model never sends coordinates. It sends measurements, and this decides
 * where everything goes.
 */
const { esc } = require("./lessonDocHtml");

const GEOMETRY_TYPES = ["triangle", "pythagoras", "circle", "rectangle", "angle", "grid"];

const W = 640;
/*
 * Each figure gets the canvas it needs rather than one average height.
 *
 * The Pythagoras construction is nearly square in its own units — the squares on
 * the legs push it left and down as far as the hypotenuse square pushes it up
 * and right — so on a wide, short canvas it was fitted by HEIGHT and came out a
 * third of the size it should be, marooned in white space. The tall figures get
 * tall canvases; the wide ones stay wide.
 */
const HEIGHTS = { pythagoras: 440, grid: 420, triangle: 330, circle: 360, rectangle: 320, angle: 320 };
const H_DEFAULT = 340;
const INK = "#2B3350";
const LINE = "#44577F";
const ACCENT = "#5369D6";
const FILL = "#5369D6";
const GROUND = "#F4F6FF";

const n2 = (v) => Number(v.toFixed(2));
// Lengths are shown the way a teacher writes them: 5 rather than 5.00, and 2.83
// rather than 2.8284271247461903.
const num = (v) => {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r).replace(".", ",");
};

/*
 * `halo` paints the label's own outline in the ground colour BEHIND the glyphs,
 * so a measurement stays readable wherever it lands — on a line, on a fill, on
 * another figure's edge. Without it, "Katet b = 8" on a long shallow triangle
 * sat directly on the side it was naming and could not be read at all, and no
 * amount of nudging the offset fixes that for every possible triangle.
 */
const text = (x, y, value, { size = 13, anchor = "middle", fill = INK, weight = "normal", italic = false, halo = false } = {}) =>
  `<text x="${n2(x)}" y="${n2(y)}" text-anchor="${anchor}" font-family="Arial,sans-serif" font-size="${size}"` +
  ` font-weight="${weight}"${italic ? ' font-style="italic"' : ""}` +
  `${halo ? ` paint-order="stroke" stroke="${GROUND}" stroke-width="4.5" stroke-linejoin="round"` : ""}` +
  ` fill="${fill}">${esc(String(value).slice(0, 40))}</text>`;

const poly = (pts, attrs) => `<polygon points="${pts.map((p) => `${n2(p[0])},${n2(p[1])}`).join(" ")}" ${attrs}/>`;

/*
 * Maths coordinates grow upward and SVG's grow down, and a figure must fit the
 * page whatever its numbers are. This is the ONE place that converts units to
 * pixels, so every figure below is drawn in real units and is to scale by
 * construction rather than by each function remembering to be.
 */
function fitter(points, { pad = 54, top = 52, bottom = 34, h = H_DEFAULT } = {}) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const s = Math.min((W - pad * 2) / spanX, (h - top - bottom) / spanY);
  const ox = (W - spanX * s) / 2 - minX * s;
  const oy = top + (h - top - bottom - spanY * s) / 2 + maxY * s;
  return (x, y) => [ox + x * s, oy - y * s];
}

// A label that sits OUTSIDE the shape: pushed along the outward normal of the
// edge it names, so it never lands on the line it is labelling.
const edgeLabel = (p, q, away, value, opts = {}) => {
  const mx = (p[0] + q[0]) / 2;
  const my = (p[1] + q[1]) / 2;
  const dx = mx - away[0];
  const dy = my - away[1];
  const len = Math.hypot(dx, dy) || 1;
  const off = opts.off || 20;
  return text(mx + (dx / len) * off, my + (dy / len) * off + 4, value, { weight: "bold", halo: true, ...opts });
};

// The square that marks a right angle, drawn inside the corner at `v`.
const rightAngleMark = (v, a, b, size = 15) => {
  const u1 = [(a[0] - v[0]), (a[1] - v[1])];
  const u2 = [(b[0] - v[0]), (b[1] - v[1])];
  const l1 = Math.hypot(...u1) || 1;
  const l2 = Math.hypot(...u2) || 1;
  const p1 = [v[0] + (u1[0] / l1) * size, v[1] + (u1[1] / l1) * size];
  const p2 = [v[0] + (u2[0] / l2) * size, v[1] + (u2[1] / l2) * size];
  const p3 = [p1[0] + p2[0] - v[0], p1[1] + p2[1] - v[1]];
  return poly([p1, p3, p2], `fill="none" stroke="${LINE}" stroke-width="1.6"`);
};

const pick = (values, i, fallback) => {
  const v = Number(values[i]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const name = (labels, i, fallback) => (labels[i] || fallback);

/* ------------------------------------------------------------------ triangle */
/*
 * Any triangle from its three sides. The numbers decide the shape: the third
 * vertex is where the two circles of radius b and a meet, which is the compass
 * construction a pupil is taught, done in arithmetic.
 */
function triangle(labels, values, h) {
  let a = pick(values, 0, 3);
  let b = pick(values, 1, 4);
  let c = pick(values, 2, 5);
  // Three lengths that cannot close are not a triangle. Rather than draw a
  // broken figure or nothing at all, fall back to the 3-4-5 every ninth-year
  // knows — the labels still read, and the shape is at least true.
  if (a + b <= c || a + c <= b || b + c <= a) { a = 3; b = 4; c = 5; }

  // c is the base, from A to B; C is found from the other two lengths.
  const A = [0, 0];
  const B = [c, 0];
  const cx = (b * b + c * c - a * a) / (2 * c);
  const cy = Math.sqrt(Math.max(b * b - cx * cx, 1e-9));
  const C = [cx, cy];

  const map = fitter([A, B, C], { h });
  const pA = map(...A);
  const pB = map(...B);
  const pC = map(...C);
  const centre = [(pA[0] + pB[0] + pC[0]) / 3, (pA[1] + pB[1] + pC[1]) / 3];

  let art = poly([pA, pB, pC], `fill="${FILL}" fill-opacity="0.09" stroke="${LINE}" stroke-width="2.4" stroke-linejoin="round"`);

  // A right angle is a fact about the numbers, so it is detected rather than
  // declared: the model cannot forget to say so, and cannot claim one falsely.
  const sq = (x) => x * x;
  const eps = 1e-6;
  if (Math.abs(sq(a) + sq(b) - sq(c)) < eps) art += rightAngleMark(pC, pA, pB);
  else if (Math.abs(sq(a) + sq(c) - sq(b)) < eps) art += rightAngleMark(pB, pA, pC);
  else if (Math.abs(sq(b) + sq(c) - sq(a)) < eps) art += rightAngleMark(pA, pB, pC);

  // Side a faces vertex A, b faces B, c faces C — the convention every textbook
  // here uses, so a teacher's labels land where they expect them.
  art += edgeLabel(pB, pC, centre, `${name(labels, 0, "a")} = ${num(a)}`);
  art += edgeLabel(pA, pC, centre, `${name(labels, 1, "b")} = ${num(b)}`);
  art += edgeLabel(pA, pB, centre, `${name(labels, 2, "c")} = ${num(c)}`);

  [[pA, "A"], [pB, "B"], [pC, "C"]].forEach(([p, v], i) => {
    const dx = p[0] - centre[0];
    const dy = p[1] - centre[1];
    const len = Math.hypot(dx, dy) || 1;
    art += `<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="3.4" fill="${LINE}"/>`;
    art += text(p[0] + (dx / len) * 16, p[1] + (dy / len) * 16 + 5, name(labels, i + 3, v), { size: 14, weight: "bold", fill: ACCENT, halo: true });
  });
  return art;
}

/* --------------------------------------------------------------- pythagoras */
/*
 * The figure the theorem is named for: the right triangle with a square built
 * outward on each of its three sides, each square carrying its own area. The
 * whole proof is visible in it — the two small squares hold as much as the big
 * one — which is why it is worth constructing properly rather than sketching.
 */
function pythagoras(labels, values, h) {
  const a = pick(values, 0, 3); // vertical leg
  const b = pick(values, 1, 4); // horizontal leg
  const c = Math.sqrt(a * a + b * b);

  const P = [0, 0];       // the right angle
  const B = [b, 0];       // along the horizontal leg
  const A = [0, a];       // along the vertical leg

  // Outward normal of the hypotenuse, away from the right angle.
  const nx = a / c;
  const ny = b / c;
  const hyp = [A, B, [B[0] + nx * c, B[1] + ny * c], [A[0] + nx * c, A[1] + ny * c]];
  const sqB = [P, B, [b, -b], [0, -b]];        // square on the horizontal leg
  const sqA = [P, A, [-a, a], [-a, 0]];        // square on the vertical leg

  const map = fitter([...hyp, ...sqA, ...sqB], { pad: 48, top: 50, h });
  const m = (p) => map(p[0], p[1]);
  const mid = (pts) => [
    pts.reduce((t, p) => t + p[0], 0) / pts.length,
    pts.reduce((t, p) => t + p[1], 0) / pts.length,
  ];

  const face = `fill="${FILL}" fill-opacity="0.12" stroke="${LINE}" stroke-width="1.8" stroke-linejoin="round"`;
  let art = poly(sqB.map(m), face) + poly(sqA.map(m), face) + poly(hyp.map(m), `fill="${FILL}" fill-opacity="0.2" stroke="${LINE}" stroke-width="1.8" stroke-linejoin="round"`);

  const pP = m(P);
  const pA = m(A);
  const pB = m(B);
  art += poly([pP, pB, pA], `fill="#FFFFFF" fill-opacity="0.92" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"`);
  art += rightAngleMark(pP, pB, pA, 14);

  const la = name(labels, 0, "a");
  const lb = name(labels, 1, "b");
  const lc = name(labels, 2, "c");

  // Each square says what it holds. The three areas together ARE the theorem,
  // so they are the largest type in the figure after the labels themselves.
  const areaText = (pts, label, value) => {
    const q = m(mid(pts));
    return text(q[0], q[1] - 2, label, { size: 15, weight: "bold", fill: ACCENT, halo: true }) +
      text(q[0], q[1] + 16, `= ${num(value)}`, { size: 13, halo: true });
  };
  art += areaText(sqA, `${la}²`, a * a);
  art += areaText(sqB, `${lb}²`, b * b);
  art += areaText(hyp, `${lc}²`, c * c);

  /*
   * The side lengths go INSIDE the white triangle, not outside it.
   *
   * Pushed outward the way every other figure labels its edges, each one landed
   * in the middle of the square built on that very side — "a = 3" sitting on top
   * of "a² = 9". This is the one figure whose outside is already occupied.
   */
  const centre = [(pP[0] + pA[0] + pB[0]) / 3, (pP[1] + pA[1] + pB[1]) / 3];
  const inward = (p, q, value) => {
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const dx = centre[0] - mx;
    const dy = centre[1] - my;
    const len = Math.hypot(dx, dy) || 1;
    return text(mx + (dx / len) * 15, my + (dy / len) * 15 + 4, value, { size: 12, weight: "bold", halo: true });
  };
  art += inward(pP, pA, `${la} = ${num(a)}`);
  art += inward(pP, pB, `${lb} = ${num(b)}`);
  art += inward(pA, pB, `${lc} = ${num(c)}`);
  return art;
}

/* -------------------------------------------------------------------- circle */
function circle(labels, values, h) {
  const r = pick(values, 0, 4);
  const map = fitter([[-r, -r], [r, r]], { pad: 76, top: 54, h });
  const O = map(0, 0);
  const edge = map(r, 0);
  const px = Math.abs(edge[0] - O[0]);

  let art = `<circle cx="${n2(O[0])}" cy="${n2(O[1])}" r="${n2(px)}" fill="${FILL}" fill-opacity="0.09" stroke="${LINE}" stroke-width="2.4"/>`;
  // The radius drawn at a slant rather than flat: a horizontal radius reads as
  // a diameter cut in half, which is the confusion this figure exists to clear.
  const rEnd = map(r * Math.cos(-Math.PI / 5), r * Math.sin(-Math.PI / 5));
  art += `<line x1="${n2(O[0])}" y1="${n2(O[1])}" x2="${n2(rEnd[0])}" y2="${n2(rEnd[1])}" stroke="${ACCENT}" stroke-width="2.4"/>`;
  art += `<circle cx="${n2(O[0])}" cy="${n2(O[1])}" r="4" fill="${INK}"/>`;
  art += text(O[0] - 13, O[1] + 18, name(labels, 0, "O"), { size: 14, weight: "bold", halo: true });
  art += text((O[0] + rEnd[0]) / 2 + 6, (O[1] + rEnd[1]) / 2 - 8, `${name(labels, 1, "r")} = ${num(r)}`, { size: 13, weight: "bold", fill: ACCENT, anchor: "start", halo: true });

  // The diameter, dashed, because it is the second fact this figure teaches.
  const d1 = map(-r, 0);
  const d2 = map(r, 0);
  art += `<line x1="${n2(d1[0])}" y1="${n2(d1[1])}" x2="${n2(d2[0])}" y2="${n2(d2[1])}" stroke="${LINE}" stroke-width="1.6" stroke-dasharray="6 5"/>`;
  // Along the dashed line rather than under the centre dot, where it collided
  // with both the centre's name and the radius.
  art += text((O[0] + d1[0]) / 2, O[1] - 10, `${name(labels, 2, "d")} = ${num(r * 2)}`, { size: 12, halo: true });
  return art;
}

/* ----------------------------------------------------------------- rectangle */
function rectangle(labels, values, h) {
  const w = pick(values, 0, 5);
  const hh = pick(values, 1, 3);
  const pts = [[0, 0], [w, 0], [w, hh], [0, hh]];
  const map = fitter(pts, { pad: 96, top: 54, h });
  const p = pts.map((q) => map(q[0], q[1]));
  const centre = [(p[0][0] + p[2][0]) / 2, (p[0][1] + p[2][1]) / 2];

  let art = poly(p, `fill="${FILL}" fill-opacity="0.1" stroke="${LINE}" stroke-width="2.4" stroke-linejoin="round"`);
  art += rightAngleMark(p[0], p[1], p[3], 14);
  art += edgeLabel(p[0], p[1], centre, `${name(labels, 0, "a")} = ${num(w)}`);
  art += edgeLabel(p[1], p[2], centre, `${name(labels, 1, "b")} = ${num(hh)}`);
  // Area inside, perimeter under it: the two things ever asked of this figure.
  art += text(centre[0], centre[1] - 2, `S = ${num(w * hh)}`, { size: 16, weight: "bold", fill: ACCENT, halo: true });
  art += text(centre[0], centre[1] + 20, `P = ${num(2 * (w + hh))}`, { size: 13, halo: true });
  if (Math.abs(w - hh) < 1e-9) art += text(centre[0], centre[1] + 40, "kvadrat", { size: 12, italic: true, halo: true });
  return art;
}

/* --------------------------------------------------------------------- angle */
function angle(labels, values, h) {
  let deg = Number(values[0]);
  if (!Number.isFinite(deg) || deg <= 0 || deg >= 360) deg = 60;
  const rad = (deg * Math.PI) / 180;
  const L = 10;
  const arm2 = [L * Math.cos(rad), L * Math.sin(rad)];
  const map = fitter([[0, 0], [L, 0], arm2, [0, Math.max(arm2[1], 2)]], { pad: 90, top: 58, h });
  const V = map(0, 0);
  const R1 = map(L, 0);
  const R2 = map(arm2[0], arm2[1]);

  const arcR = 44;
  const a1 = [V[0] + arcR, V[1]];
  const a2 = [V[0] + arcR * Math.cos(-rad), V[1] + arcR * Math.sin(-rad)];
  let art = `<path d="M${n2(a1[0])} ${n2(a1[1])} A ${arcR} ${arcR} 0 ${deg > 180 ? 1 : 0} 0 ${n2(a2[0])} ${n2(a2[1])}" fill="none" stroke="${ACCENT}" stroke-width="2.2"/>`;
  if (Math.abs(deg - 90) < 1e-9) art += rightAngleMark(V, R1, R2, 20);

  const arm = `stroke="${LINE}" stroke-width="2.6" stroke-linecap="round"`;
  art += `<line x1="${n2(V[0])}" y1="${n2(V[1])}" x2="${n2(R1[0])}" y2="${n2(R1[1])}" ${arm}/>`;
  art += `<line x1="${n2(V[0])}" y1="${n2(V[1])}" x2="${n2(R2[0])}" y2="${n2(R2[1])}" ${arm}/>`;
  art += `<circle cx="${n2(V[0])}" cy="${n2(V[1])}" r="4" fill="${INK}"/>`;

  const half = -rad / 2;
  art += text(V[0] + (arcR + 26) * Math.cos(half), V[1] + (arcR + 26) * Math.sin(half) + 5, `${num(deg)}°`, { size: 16, weight: "bold", fill: ACCENT });
  art += text(V[0] - 14, V[1] + 16, name(labels, 0, "O"), { size: 14, weight: "bold" });
  art += text(R1[0] + 14, R1[1] + 5, name(labels, 1, "A"), { size: 13, weight: "bold" });
  art += text(R2[0] + 12, R2[1] - 8, name(labels, 2, "B"), { size: 13, weight: "bold" });
  return art;
}

/* ---------------------------------------------------------------------- grid */
/*
 * A coordinate plane with the points actually plotted. `values` arrive in pairs
 * — x, y, x, y — because that is how a teacher dictates them.
 */
function grid(labels, values, h) {
  const pts = [];
  for (let i = 0; i + 1 < values.length && pts.length < 4; i += 2) {
    const x = Number(values[i]);
    const y = Number(values[i + 1]);
    if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
  }
  if (!pts.length) pts.push([2, 3], [-3, 1]);

  // The axes always show, and always include zero, so the quadrants are honest.
  const ext = Math.max(4, ...pts.flat().map((v) => Math.ceil(Math.abs(v)) + 1));
  const map = fitter([[-ext, -ext], [ext, ext]], { pad: 64, top: 50, h });
  const O = map(0, 0);

  let art = "";
  for (let i = -ext; i <= ext; i += 1) {
    const v = map(i, 0);
    const hLine = map(0, i);
    const faint = `stroke="#C9D2F0" stroke-width="1"`;
    art += `<line x1="${n2(v[0])}" y1="${n2(map(0, -ext)[1])}" x2="${n2(v[0])}" y2="${n2(map(0, ext)[1])}" ${faint}/>`;
    art += `<line x1="${n2(map(-ext, 0)[0])}" y1="${n2(hLine[1])}" x2="${n2(map(ext, 0)[0])}" y2="${n2(hLine[1])}" ${faint}/>`;
  }
  const axis = `stroke="${INK}" stroke-width="2"`;
  art += `<line x1="${n2(map(-ext, 0)[0])}" y1="${n2(O[1])}" x2="${n2(map(ext, 0)[0])}" y2="${n2(O[1])}" ${axis}/>`;
  art += `<line x1="${n2(O[0])}" y1="${n2(map(0, ext)[1])}" x2="${n2(O[0])}" y2="${n2(map(0, -ext)[1])}" ${axis}/>`;
  art += text(map(ext, 0)[0] + 12, O[1] + 5, "x", { size: 13, italic: true });
  art += text(O[0] - 12, map(0, ext)[1] - 6, "y", { size: 13, italic: true });
  art += text(O[0] - 10, O[1] + 16, "0", { size: 11 });

  // Ticks only where they can be read: every unit on a crowded axis is noise.
  const step = ext > 6 ? 2 : 1;
  for (let i = -ext + 1; i < ext; i += step) {
    if (i === 0) continue;
    const vx = map(i, 0);
    const vy = map(0, i);
    art += `<line x1="${n2(vx[0])}" y1="${n2(O[1] - 4)}" x2="${n2(vx[0])}" y2="${n2(O[1] + 4)}" stroke="${INK}" stroke-width="1.6"/>`;
    art += text(vx[0], O[1] + 18, i, { size: 10, halo: true });
    art += `<line x1="${n2(O[0] - 4)}" y1="${n2(vy[1])}" x2="${n2(O[0] + 4)}" y2="${n2(vy[1])}" stroke="${INK}" stroke-width="1.6"/>`;
    art += text(O[0] - 11, vy[1] + 4, i, { size: 10, anchor: "end", halo: true });
  }

  pts.forEach(([x, y], i) => {
    const p = map(x, y);
    art += `<circle cx="${n2(p[0])}" cy="${n2(p[1])}" r="5.5" fill="${ACCENT}"/>`;
    art += text(p[0] + 10, p[1] - 10, `${name(labels, i, String.fromCharCode(65 + i))}(${num(x)}; ${num(y)})`, {
      size: 12, weight: "bold", anchor: "start", halo: true,
    });
  });
  return art;
}

const FIGURES = { triangle, pythagoras, circle, rectangle, angle, grid };

/*
 * The figure, framed. Same canvas, ground and title bar as the semantic
 * diagrams, so a material that mixes a flow chart and a triangle looks like one
 * document rather than two.
 */
function geometrySvg(d) {
  const draw = FIGURES[d.type];
  if (!draw) return "";
  const labels = (Array.isArray(d.labels) ? d.labels : []).map((s) => String(s).slice(0, 24));
  const values = (Array.isArray(d.values) ? d.values : []).map(Number).filter(Number.isFinite);
  const title = d.title
    ? `<text x="${W / 2}" y="30" text-anchor="middle" font-family="Arial,sans-serif" font-size="16" fill="${INK}">${esc(d.title)}</text>`
    : "";
  const h = HEIGHTS[d.type] || H_DEFAULT;
  let art = "";
  try {
    art = draw(labels, values, h);
  } catch {
    // A figure that cannot be constructed must not take the whole material with
    // it. Nothing is drawn, the block renders as its title, and the lesson survives.
    return "";
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(d.title || "Fiqur")}">` +
    `<rect width="100%" height="100%" rx="16" fill="#F4F6FF"/><g>${title}${art}</g></svg>`;
}

module.exports = { GEOMETRY_TYPES, geometrySvg };
