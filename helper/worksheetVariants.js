/*
 * "İki variantda iş vərəqi generatoru" — the two-variant worksheet the teacher's
 * lesson-plan prompt asks for.
 *
 * This is a DERIVATION, not a second AI call: variant B is produced from variant A
 * by perturbing the approved variables of a task's server-owned adaptation template
 * and recomputing the answer with the same pinned evaluator. So it costs no
 * credits, cannot hallucinate, and cannot contradict the plan it came from.
 *
 * A task with no formal model is copied into both variants UNCHANGED and marked
 * `needs_teacher_review`. That is the honest outcome: for an arbitrary word problem
 * there is nothing to recompute, so claiming a verified variant would be a lie.
 */
const { TEMPLATES, templateHashOf, computeAdaptation } = require("./adaptationTemplates");

/*
 * A deterministic nudge scaled off the VALUE, not the template's declared span.
 *
 * The teacher's prompt is explicit that a variant keeps its difficulty: "Süjet,
 * ifadə tərzi və çətinlik səviyyəsi saxlanılır" — only the numbers move. Scaling
 * off the declared bounds instead would turn "5 sm" into "56 sm" and change the
 * arithmetic a pupil has to do. An integer stays an integer for the same reason.
 */
function perturb(decl, value, seed) {
  const magnitude = Math.abs(value) || 1;
  // 15%, 25% or 35% of the value, alternating direction — enough that the paper is
  // visibly different, small enough that the task is the same task.
  const pct = [0.15, 0.25, 0.35][seed % 3];
  const dir = seed % 2 === 0 ? 1 : -1;
  const isInt = Number.isInteger(value);
  let delta = magnitude * pct * dir;
  if (isInt) delta = Math.max(1, Math.round(Math.abs(delta))) * dir;

  let next = value + delta;
  if (next < decl.min || next > decl.max) next = value - delta; // try the other way
  if (next < decl.min) next = decl.min;
  if (next > decl.max) next = decl.max;
  if (isInt) next = Math.round(next);
  // A "variant" identical to the original is not one.
  if (next === value) next = value + 1 <= decl.max ? value + 1 : value - 1;
  return isInt ? next : Number(next.toFixed(4));
}

/*
 * Build variant B for one task.
 * Returns { ok, task, reason } — `ok:false` means the task could not be varied
 * safely and must go to the teacher rather than be guessed at.
 */
function varyTask(task, seed = 0) {
  const a = task && task.adaptation;
  if (!a || !a.templateId) return { ok: false, reason: "no_formal_model" };
  const tpl = TEMPLATES[a.templateId];
  if (!tpl) return { ok: false, reason: "template_unknown" };
  // Pinned semantics must still match, or the recomputation would mean something
  // different from what the plan was authored against.
  if (a.templateHash && a.templateHash !== templateHashOf(a.templateId)) {
    return { ok: false, reason: "template_hash_mismatch" };
  }

  const supplied = Array.isArray(a.variables) ? a.variables : [];
  const variables = [];
  for (const [i, decl] of tpl.variables.entries()) {
    const hit = supplied.find((v) => v && v.name === decl.name);
    if (!hit || !Number.isFinite(Number(hit.value))) return { ok: false, reason: "variable_missing" };
    variables.push({ name: decl.name, unit: decl.unit, value: perturb(decl, Number(hit.value), seed + i) });
  }

  const adaptation = { ...a, variables, computed: undefined };
  const computed = computeAdaptation(adaptation);
  if (!computed.ok) return { ok: false, reason: computed.code };
  adaptation.computed = computed.value;
  adaptation.computedUnit = computed.unit;

  /*
   * Rewrite the numbers in the statement.
   *
   * TWO PASSES, via placeholders. A single sequential pass corrupts the text
   * whenever one variable's NEW value equals another's OLD one: rewriting 5->4 and
   * then 4->3 would rewrite the 4 that the first pass had just produced. Each
   * variable is therefore parked under a private-use marker no real text contains,
   * and only then materialised.
   */
  let statement = String(task.statement || "");
  const marks = [];
  tpl.variables.forEach((decl, i) => {
    const from = Number(supplied.find((v) => v.name === decl.name).value);
    // ONE private-use codepoint per index. It must be digit-free (or a later pass
    // matches the index inside an earlier marker) and fixed-width (or a shorter
    // marker is a substring of a longer one and materialising corrupts it).
    const mark = String.fromCharCode(0xe010 + i);
    // Whole numeric token only, so "4" never matches inside "14" or "4.5".
    const re = new RegExp(`(^|[^\\d.,])${String(from).replace(".", "[.,]")}(?![\\d.,])`);
    if (re.test(statement)) {
      statement = statement.replace(re, (m, pre) => `${pre}${mark}`);
      marks.push({ mark, value: variables[i].value });
    }
  });
  for (const { mark, value } of marks) statement = statement.split(mark).join(String(value));

  return {
    ok: true,
    task: {
      ...task,
      variant: "B",
      statement,
      adaptation,
      answer: String(computed.value),
      solution: "",
      reviewStatus: "pending",
    },
  };
}

/*
 * FALLBACK: vary the numbers written in the statement itself.
 *
 * Most lesson-plan tasks carry no formal template — the AI wrote prose with numbers
 * in it. Without this the "two variants" were the SAME PAPER TWICE, which is worse
 * than no feature: a teacher hands out A and B believing pupils cannot copy.
 *
 * So the numbers in the text are shifted. No answer is produced or claimed for
 * these — there is nothing to recompute against, and inventing one would be the
 * dishonesty the template path exists to avoid. The teacher works the answers out,
 * which is what a worksheet is for.
 */
const NUM_RE = /-?\d+(?:[.,]\d+)?/g;

/*
 * Shift is decided PER DISTINCT VALUE, not per position.
 *
 * That preserves the pattern of equality in both directions, which is what keeps a
 * task solvable and keeps its point intact:
 *   - A(2;3) B(5;11) must not become A(4;6) B(4;9): two equal x-coordinates make a
 *     vertical line, and the slope the pupil is asked for does not exist;
 *   - E(2;5) F(2;10) must STAY vertical, because the teacher chose that case on
 *     purpose to test it.
 * Equal values move together; different values keep different shifts, and a
 * collision falls back to a wider spread.
 */
function shiftFor(value, seed, spread = 0) {
  const steps = [1, 2, 3, -1, -2, 4, -3];
  const step = steps[(seed + spread) % steps.length] * (spread ? 2 : 1);
  let next = Number.isInteger(value) ? value + step : Number((value + step).toFixed(2));
  // Never flip a positive quantity to zero or negative — that can turn a sensible
  // task into nonsense (a length of -1, a division by zero).
  if (value > 0 && next <= 0) next = value + Math.abs(step);
  return next;
}

function varyByText(task, seed = 0) {
  const text = String(task.statement || "");
  const found = [...text.matchAll(NUM_RE)];
  if (!found.length) return { ok: false, reason: "no_numbers_in_text" };

  const values = found.map((m) => Number(m[0].replace(",", ".")));
  const distinct = [...new Set(values)];

  // One shift per distinct value, widened until no two distinct values collide.
  let map = null;
  for (let spread = 0; spread <= 6 && !map; spread++) {
    const candidate = new Map();
    distinct.forEach((v, i) => candidate.set(v, shiftFor(v, seed + i, spread)));
    const produced = [...candidate.values()];
    const collides = new Set(produced).size !== produced.length;
    const unchanged = distinct.every((v) => candidate.get(v) === v);
    if (!collides && !unchanged) map = candidate;
  }
  if (!map) return { ok: false, reason: "could_not_vary_safely" };

  let out = "";
  let last = 0;
  found.forEach((m, i) => {
    const dec = m[0].includes(",") ? "," : ".";
    const rendered = String(map.get(values[i])).replace(".", dec);
    out += text.slice(last, m.index) + rendered;
    last = m.index + m[0].length;
  });
  out += text.slice(last);

  if (out === text) return { ok: false, reason: "numbers_unchanged" };
  return {
    ok: true,
    task: {
      ...task,
      variant: "B",
      statement: out,
      // Nothing here was recomputed, so nothing is asserted: no answer, no solution.
      answer: "",
      solution: "",
      adaptation: undefined,
      reviewStatus: "pending",
      reviewNotes: undefined,
    },
  };
}

/*
 * Two variants of a whole worksheet.
 *
 * `unvaried` lists the tasks that could not be varied and why, so the UI can say
 * plainly which ones the teacher must adjust by hand instead of silently shipping
 * two identical papers.
 */
function buildWorksheet(tasks) {
  // Fail loudly rather than emitting a worksheet of blank rows: a Mongoose
  // subdocument spreads to its internals, so a caller that forgot .toObject()
  // would silently produce numbered lines with no question on them.
  const list = Array.isArray(tasks) ? tasks : [];
  const suspect = list.filter((t) => t && typeof t === "object" && t.$__ !== undefined);
  if (suspect.length) {
    throw new Error("buildWorksheet: pass PLAIN tasks (call .toObject() first) — Mongoose subdocuments do not spread");
  }
  const A = [];
  const B = [];
  const unvaried = [];
  let textVaried = 0;

  list.forEach((t, i) => {
    const no = i + 1;
    const base = { ...t, no, pairId: `w${no}`, variant: "A", reviewStatus: t.reviewStatus || "pending" };
    A.push(base);

    // Prefer the template path: it recomputes the ANSWER and can be trusted. Fall
    // back to shifting the numbers in the text, which changes the paper without
    // claiming any answer.
    let varied = varyTask(base, no);
    let byText = false;
    if (!varied.ok) {
      const alt = varyByText(base, no);
      // Report why the TEXT path failed — "no_formal_model" is about the template
      // path and tells the teacher nothing about a task written in words.
      varied = alt.ok ? alt : alt;
      byText = alt.ok;
    }
    if (varied.ok) {
      B.push({ ...varied.task, no, pairId: `w${no}`, ...(byText ? { variedBy: "text" } : { variedBy: "template" }) });
      if (byText) textVaried += 1;
    } else {
      unvaried.push({ no, reason: varied.reason });
      B.push({
        ...base,
        variant: "B",
        reviewStatus: "needs_teacher_review",
        reviewNotes: [
          ...(base.reviewNotes || []),
          "Bu tapşırıq üçün rəqəmləri dəyişmək avtomatik mümkün olmadı — variant B-ni özünüz uyğunlaşdırın.",
        ],
      });
    }
  });

  return { A, B, unvaried, textVaried, variedCount: list.length - unvaried.length };
}

module.exports = { perturb, varyTask, varyByText, buildWorksheet };
