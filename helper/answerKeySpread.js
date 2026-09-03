/*
 * "Ardıcıl olaraq təkrarlanan düzgün cavablar olmamalıdır."
 *
 * The prompt asks for it. The model does not reliably deliver it — the live German
 * paper came back B A A B B A C D B C D, with A repeated at 2→3 and B at 4→5. A
 * student who notices a run stops reading the question and copies the letter, which
 * is exactly what the requirement exists to prevent.
 *
 * This is a property that can be checked and repaired exactly, so it is enforced
 * rather than requested. Rotating a question's options and its key TOGETHER cannot
 * change which option is correct — the same text is still the answer, it just sits
 * at a different letter. That makes this a safe transform, unlike anything that
 * rewrites content.
 *
 * Two things it deliberately will not touch:
 *   - options that reference each other positionally ("yuxarıdakıların hamısı",
 *     "heç biri", "A və B"), where the order carries meaning;
 *   - questions with several correct answers, where "the key letter" is not one
 *     thing to compare.
 */

// Options whose meaning depends on where they sit, or on the other options.
const POSITIONAL = /(hamısı|heç\s*bir|yuxarıdak|aşağıdak|bütün variant|all of the above|none of the above)/iu;

const textOf = (c) => String((c && typeof c === "object" ? c.text : c) || "");

function isRotatable(q) {
  if (!q || q.type === "reading") return false;
  const ch = q.choices;
  if (!Array.isArray(ch) || ch.length < 2) return false;
  if (!Array.isArray(q.correct) || q.correct.length !== 1) return false;
  if (!Number.isInteger(q.correct[0])) return false;
  if (q.correct[0] < 0 || q.correct[0] >= ch.length) return false;
  return !ch.some((c) => POSITIONAL.test(textOf(c)));
}

// Rotate right by k: the option that was at i moves to (i + k) % n, so the key
// moves with it and the correct TEXT is unchanged.
function rotate(q, k) {
  const n = q.choices.length;
  const out = new Array(n);
  q.choices.forEach((c, i) => {
    out[(i + k) % n] = c;
  });
  return { ...q, choices: out, correct: [(q.correct[0] + k) % n] };
}

/*
 * Walk the paper in order and break any run. Only the SECOND question of a pair is
 * moved, so a single repair cannot cascade down the paper, and each move is checked
 * against the question before it — the one already decided.
 *
 * Returns the (possibly) new list plus a count, so the caller can report honestly
 * rather than claim a guarantee it did not achieve: a question that is not
 * rotatable is left exactly as the model wrote it.
 */
function spreadAnswerKeys(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  let rotated = 0;
  let remaining = 0;
  let prevKey = null;

  for (let i = 0; i < list.length; i += 1) {
    const q = list[i];
    if (!q || q.type === "reading") continue;
    const key = Array.isArray(q.correct) && q.correct.length === 1 ? q.correct[0] : null;
    if (key === null) {
      prevKey = null; // an open task breaks the run on its own
      continue;
    }

    if (key === prevKey && isRotatable(q)) {
      const n = q.choices.length;
      // Smallest rotation that moves the key off the previous letter. With n >= 2
      // one always exists, so the loop cannot fall through silently.
      let done = false;
      for (let k = 1; k < n && !done; k += 1) {
        const cand = (key + k) % n;
        if (cand !== prevKey) {
          list[i] = rotate(q, k);
          rotated += 1;
          prevKey = cand;
          done = true;
        }
      }
      if (done) continue;
    }

    if (key === prevKey) remaining += 1; // could not be fixed safely; reported, not hidden
    prevKey = Array.isArray(list[i].correct) ? list[i].correct[0] : key;
  }

  return { items: list, rotated, remaining };
}

// Reporting helper: the key as letters, for a teacher-facing check.
const keyLetters = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((q) => q && q.type !== "reading")
    .map((q) =>
      Array.isArray(q.correct) && q.correct.length === 1
        ? String.fromCharCode(65 + q.correct[0])
        : "—"
    );

module.exports = { spreadAnswerKeys, keyLetters, isRotatable, POSITIONAL };
