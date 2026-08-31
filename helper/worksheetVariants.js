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
 * Two variants of a whole worksheet.
 *
 * `unvaried` lists the tasks that could not be varied and why, so the UI can say
 * plainly which ones the teacher must adjust by hand instead of silently shipping
 * two identical papers.
 */
function buildWorksheet(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const A = [];
  const B = [];
  const unvaried = [];

  list.forEach((t, i) => {
    const no = i + 1;
    const base = { ...t, no, pairId: `w${no}`, variant: "A", reviewStatus: t.reviewStatus || "pending" };
    A.push(base);

    const varied = varyTask(base, no);
    if (varied.ok) {
      B.push({ ...varied.task, no, pairId: `w${no}` });
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

  return { A, B, unvaried, variedCount: list.length - unvaried.length };
}

module.exports = { perturb, varyTask, buildWorksheet };
