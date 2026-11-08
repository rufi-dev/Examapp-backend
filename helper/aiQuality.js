/*
 * Quality steps around the AI's questions, ported from Examopia's aiController
 * (2026-11-08) and trimmed to BunkerMath's question types (Cm, Cs, Co, Cd, Cma —
 * no reading passages, gap-fills or manual grading). All local and pure: the AI
 * calls that use them live in controllers/aiController.js.
 *
 *   cleanQuestions   text clean-up + matching repair, on every route
 *   auditQuestions   rule-based checks, the input to review / solving
 *   answerOnly       lay ONLY an answer onto the teacher's own question
 *   parseRequestedCount / questionKey   "20 sual" fidelity + top-up de-dupe
 *   REVIEW_SYSTEM_PROMPT / SOLVE_SYSTEM_PROMPT
 */

/* ---------- text clean-up ---------- */

const unescapeQuotes = (t) => String(t ?? "").replace(/\\+(["'])/g, "$1");

// Real maths carries a command, a super/subscript, a brace group, or an operator
// between numbers. Prose carries none, so a $...$ around prose can go.
const looksLikeMath = (s) => /[\\^_{}]|\d\s*[+\-*/=]\s*\d/.test(s);

// `$` DELIMITER tokens, ignoring `\$` and counting `$$` once: odd = a dropped `$`.
const dollarDelims = (s) => {
  const str = String(s ?? "");
  let n = 0;
  for (let i = 0; i < str.length; i += 1) {
    if (str[i] === "\\" && str[i + 1] === "$") {
      i += 1;
      continue;
    }
    if (str[i] === "$") {
      if (str[i + 1] === "$") i += 1;
      n += 1;
    }
  }
  return n;
};

// Raw LaTeX a student would see: an unbalanced `$`, or a command / sub-superscript
// OUTSIDE every $...$ span.
const hasMathLeak = (s) => {
  const str = String(s ?? "");
  if (!str) return false;
  if (dollarDelims(str) % 2 !== 0) return true;
  const outside = str
    .replace(/\\\$/g, "")
    .replace(/\$\$[\s\S]*?\$\$/g, "")
    .replace(/\$[^$]*\$/g, "");
  return /\\[a-zA-Z]{2,}|[_^]\{|[A-Za-z0-9][_^][A-Za-z0-9]/.test(outside);
};

const stripProseMath = (t) => {
  const s = String(t ?? "").trim();
  if (!(s.startsWith("$") && s.endsWith("$") && s.length > 2)) return t;
  const inner = s.slice(1, -1);
  if (inner.includes("$")) return t; // several segments, not one wrapper
  if (looksLikeMath(inner)) return t;
  return inner.trim();
};

// `\times` written as a JSON tab + "imes": a control char followed by a letter
// was the start of a command. A correctly escaped one has no control char.
const fixMathEscapes = (t) =>
  String(t)
    .replace(/\t(?=[a-zA-Z])/g, "\\t")
    .replace(/\f(?=[a-zA-Z])/g, "\\f")
    .replace(/\x08(?=[a-zA-Z])/g, "\\b")
    .replace(/\r(?=[a-zA-Z])/g, "\\r");

// Azerbaijani Ə/ə mis-read as Greek θ ("ƏBOB → θBOB", "hərf → hθrf"). Inside a
// WORD a theta is a mangled Ə; a standalone angle θ and anything in $...$ is left.
const fixAzTheta = (s) => {
  const str = String(s);
  if (str.indexOf("θ") === -1 && str.indexOf("Θ") === -1) return str;
  const fixProse = (p) =>
    p
      .replace(/(\p{L})[θΘ]/gu, (_m, a) => a + (/\p{Lu}/u.test(a) ? "Ə" : "ə"))
      .replace(/[θΘ](\p{L})/gu, (_m, b) => (/\p{Lu}/u.test(b) ? "Ə" : "ə") + b);
  const re = /\\\$|\$\$[\s\S]*?\$\$|\$[^$]*\$/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) out += fixProse(str.slice(last, m.index));
    out += m[0];
    last = re.lastIndex;
  }
  if (last < str.length) out += fixProse(str.slice(last));
  return out;
};

const cleanText = (t) => (typeof t === "string" ? fixAzTheta(stripProseMath(fixMathEscapes(unescapeQuotes(t)))) : t);

/* ---------- matching (Cma) repair ---------- */

// The app shows a matching question as a bare number→letter grid: nothing in
// `pairs` reaches the student, and the grid only knows a–z.
const LETTER_LINE = /^([^\s).\]]{1,2})\s*[).\]]\s+/;

// Azerbaijani-letter labels (ç, ə…) renamed a, b, c… by position, in the text AND
// the key. Nothing invented or dropped.
const normaliseMatchingLetters = (q) => {
  if (q?.type !== "Cma" || !Array.isArray(q.pairs) || !q.pairs.length) return q;
  const rights = q.pairs.flatMap((p) =>
    String(p?.right ?? "")
      .split(/[,;/|\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!rights.length || rights.every((r) => /^[a-z]$/.test(r))) return q;
  const text = String(q.text || "");
  const labels = [];
  for (const line of text.split("\n")) {
    const m = line.match(LETTER_LINE);
    const label = m && m[1].toLowerCase();
    if (label && !/^\d+$/.test(label) && !labels.includes(label)) labels.push(label);
  }
  if (labels.length < 2) return q;
  const latin = (i) => String.fromCharCode(97 + i);
  const remap = new Map(labels.map((l, i) => [l, latin(i)]));
  if (labels.every((l, i) => l === latin(i))) return q;
  const newText = text
    .split("\n")
    .map((line) => {
      const m = line.match(LETTER_LINE);
      const label = m && m[1].toLowerCase();
      if (!label || !remap.has(label)) return line;
      return line.replace(m[1], remap.get(label));
    })
    .join("\n");
  return {
    ...q,
    text: newText,
    pairs: q.pairs.map((p) => ({
      ...p,
      right: String(p?.right ?? "")
        .split(/[,;/|\s]+/)
        .map((s) => remap.get(s.trim().toLowerCase()) ?? s.trim())
        .filter(Boolean)
        .join(", "),
    })),
  };
};

// Items written INTO pairs.left (never displayed) are moved into the text, the
// one place the student sees — "the single most common way it gets this type
// wrong". Only when the text has no numbered list of its own.
const foldMatchingItemsIntoText = (q) => {
  if (q?.type !== "Cma" || !Array.isArray(q.pairs) || q.pairs.length < 2) return q;
  const contentful = q.pairs.filter((p) => {
    const left = String(p?.left ?? "").trim();
    return left && !/^\d+[.)]?$/.test(left);
  });
  if (contentful.length !== q.pairs.length) return q;
  const text = String(q.text || "");
  const stripped = (s) => s.replace(/^\s*\d+\s*[.)]\s*/, "").trim();
  const numberedLines = (text.match(/^\s*\d+\s*[.)]/gm) || []).length;
  if (numberedLines >= q.pairs.length) return q;
  const list = q.pairs.map((p, i) => `${i + 1}. ${stripped(String(p?.left ?? ""))}`).join("\n");
  return {
    ...q,
    text: `${text.trim()}\n${list}`.trim(),
    pairs: q.pairs.map((p, i) => ({ ...p, left: String(i + 1) })),
  };
};

const cleanQuestions = (list) =>
  (Array.isArray(list) ? list : []).map((q0) => {
    const q = normaliseMatchingLetters(foldMatchingItemsIntoText(q0));
    if (!q || typeof q !== "object") return q;
    const out = { ...q };
    out.text = cleanText(q.text);
    if (typeof q.latex === "string") out.latex = fixMathEscapes(q.latex);
    if (typeof q.openAnswer === "string") out.openAnswer = cleanText(q.openAnswer);
    if (Array.isArray(q.openAnswers)) out.openAnswers = q.openAnswers.map(cleanText);
    if (typeof q.explanation === "string") out.explanation = cleanText(q.explanation);
    if (Array.isArray(q.choices)) {
      out.choices = q.choices.map((c) =>
        c && typeof c === "object"
          ? { ...c, text: cleanText(c.text), ...(typeof c.latex === "string" ? { latex: fixMathEscapes(c.latex) } : {}) }
          : cleanText(c)
      );
    }
    if (Array.isArray(q.pairs)) {
      out.pairs = q.pairs.map((pr) => (pr && typeof pr === "object" ? { ...pr, left: cleanText(pr.left), right: cleanText(pr.right) } : pr));
    }
    return out;
  });

/* ---------- rule-based audit ---------- */

const AUDIT_STRIP = (s) =>
  String(s ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const AUDIT_TYPES = new Set(["Cm", "Cs", "Co", "Cd", "Cma"]);
const splitMatchLabels = (s) =>
  String(s ?? "")
    .split(/[,;/|\s]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
const letterLabelsInText = (text) => {
  const labels = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(LETTER_LINE);
    const label = m && String(m[1] || "").toLowerCase();
    if (label && !/^\d+$/.test(label) && /^[a-z]$/.test(label) && !labels.includes(label)) labels.push(label);
  }
  return labels;
};

// An open (Co) answer is only fair with ONE exact spelling a student can type.
const OPEN_ENDED_QUESTION_RE =
  /(sadala|izah\s*ed|şərh\s*ed|müzakirə|təsvir\s*ed|fikrin|fikriniz|fikrincə|nümunə|misal|qısaca\s*yaz|qısa\s*qeyd|öz\s*sözlər|nələr|nə\s*nəticə|nəticələrə\s*səbəb|nə\s*baş\s*ver|necə\s*dəyiş|nə\s*olur|necədir|barədə\s*yaz|haqqında\s*yaz|niyə|nə\s*üçün|qeyd\s*ed|bilirsiniz|bilirsən)/;
const answerIsConcrete = (s) => {
  const t = String(s ?? "").trim();
  if (!t) return false;
  if (/^[-+]?\d[\d.,:/%\s-]*$/.test(t)) return true;
  if (/[=+\-*/^()$∙×÷√πθ]|\\[a-z]/i.test(t) && t.split(/\s+/).filter(Boolean).length <= 6) return true;
  return false;
};
const wordCount = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
const looksOpenEndedOpen = (q) => {
  if (q?.type !== "Co") return false;
  const text = AUDIT_STRIP(q.text);
  if (!text) return false;
  const answers = [...(Array.isArray(q.openAnswers) ? q.openAnswers : []), q.openAnswer]
    .map((x) => String(x ?? "").trim())
    .filter(Boolean);
  if (answers.length && answers.every((a) => answerIsConcrete(a) || wordCount(a) <= 2)) return false;
  const subjective = OPEN_ENDED_QUESTION_RE.test(text);
  const phraseAnswer = answers.some(
    (a) =>
      !answerIsConcrete(a) &&
      (wordCount(a) >= 4 || (/(^|\s)(və|həmçinin|eləcə)(\s|$)|[,;]/.test(a.toLowerCase()) && wordCount(a) >= 3))
  );
  return subjective || phraseAnswer;
};

/*
 * [{index, code, detail}] — the structural mistakes that turn into a mis-marked or
 * unanswerable question. `requireAnswers` is on where the AI owns the key
 * (generation, solving) and off for plain extraction.
 */
const auditQuestions = (list, { requireAnswers = false } = {}) => {
  const issues = [];
  const add = (index, code, detail) => issues.push({ index, code, detail });
  (Array.isArray(list) ? list : []).forEach((q, i) => {
    if (!q || typeof q !== "object") return add(i, "not-an-object", "");
    if (!AUDIT_TYPES.has(q.type)) return add(i, "unknown-type", `type=${q.type || ""}`);
    const hasFig = !!q.hasFigure;
    if (!AUDIT_STRIP(q.text) && !hasFig) add(i, "empty-text", "question has no text");
    if (hasMathLeak(q.text)) add(i, "math-delimiters", "unwrapped or unbalanced LaTeX in text — wrap every formula in $...$");
    const choices = Array.isArray(q.choices) ? q.choices : [];
    const texts = choices.map((c) => AUDIT_STRIP(c?.text ?? c));
    choices.forEach((c, ci) => {
      if (hasMathLeak(c?.text)) add(i, "math-delimiters", `unwrapped or unbalanced LaTeX in choice ${ci + 1} — wrap every formula in $...$`);
    });
    const correct = Array.isArray(q.correct) ? q.correct : [];
    if (q.type === "Cm" || q.type === "Cs") {
      if (choices.length < 2) add(i, "too-few-choices", `only ${choices.length} choice(s)`);
      texts.forEach((t, ci) => {
        if (!t && !hasFig) add(i, "empty-choice", `choice ${ci + 1} is blank`);
      });
      const seen = new Map();
      texts.forEach((t, ci) => {
        if (!t) return;
        if (seen.has(t)) add(i, "duplicate-choice", `choices ${seen.get(t) + 1} and ${ci + 1} are identical`);
        else seen.set(t, ci);
      });
      correct.forEach((idx) => {
        if (!Number.isInteger(idx) || idx < 0 || idx >= choices.length) add(i, "bad-correct-index", `correct=${idx} but there are ${choices.length} choices`);
      });
      if (q.type === "Cm" && correct.length > 1) add(i, "cm-multi-correct", `single-choice marked ${correct.length} correct answers`);
      if (requireAnswers && correct.length === 0) add(i, "no-correct-answer", "no correct answer marked");
    } else if (q.type === "Co" || q.type === "Cd") {
      const answers = (Array.isArray(q.openAnswers) ? q.openAnswers : []).map(AUDIT_STRIP).filter(Boolean);
      if (AUDIT_STRIP(q.openAnswer)) answers.push(AUDIT_STRIP(q.openAnswer));
      if (requireAnswers && !answers.length) add(i, "no-open-answer", "no accepted answer");
      if (choices.length) add(i, "open-with-choices", "open question should have no choices");
      if (requireAnswers && q.type === "Co" && looksOpenEndedOpen(q)) {
        add(i, "open-ended-answer", "açıq-uçlu/çoxcavablı açıq sual — şagird cavabı dəqiq uyğunlaşdıra bilməz: «Cm» çoxseçimli et (düzgün cavabı variant kimi saxla, 4-5 variant qur, openAnswers boşalt)");
      }
    } else if (q.type === "Cma") {
      const pairs = Array.isArray(q.pairs) ? q.pairs : [];
      if (pairs.length < 2) add(i, "too-few-pairs", `only ${pairs.length} pair(s)`);
      const numberedLines = (String(q.text || "").match(/^\s*\d+\s*[.)]/gm) || []).length;
      if (pairs.length >= 2 && numberedLines < pairs.length) add(i, "matching-missing-left-list", `text shows ${numberedLines} numbered item(s), pairs has ${pairs.length}`);
      const labels = letterLabelsInText(q.text);
      const labelSet = new Set(labels);
      if (pairs.length >= 2 && labels.length < 2) add(i, "matching-missing-letter-list", "text has no visible a/b/c letter list");
      pairs.forEach((p, pi) => {
        const left = String(p?.left ?? "").trim();
        const rights = splitMatchLabels(p?.right);
        if (!AUDIT_STRIP(left)) add(i, "incomplete-pair", `pair ${pi + 1} has no left item`);
        else if (!/^\d+[.)]?$/.test(left)) add(i, "matching-left-not-label", `pair ${pi + 1} left should be just a number`);
        if (requireAnswers && !rights.length) add(i, "incomplete-pair", `pair ${pi + 1} has no answer letter`);
        rights.forEach((r) => {
          if (!/^[a-z]$/.test(r) || (labelSet.size && !labelSet.has(r))) add(i, "bad-matching-label", `pair ${pi + 1} uses '${r}'`);
        });
      });
    }
  });
  return issues;
};

const UNANSWERED = new Set(["no-correct-answer", "no-open-answer", "incomplete-pair"]);
// WHICH questions have no answer — recorded before solving, so the AI's answers
// can be told apart from the paper's own.
const unansweredIndexes = (questions) =>
  new Set(
    auditQuestions(questions, { requireAnswers: true })
      .filter((x) => UNANSWERED.has(x.code))
      .map((x) => x.index)
  );

/* ---------- answers only ---------- */

/*
 * Only the ANSWER of `got`, laid onto the teacher's own question: type, text and
 * options always stay the original ones. Answered in a different shape → carried
 * across by its text where possible, dropped where not.
 */
function answerOnly(orig, got) {
  if (!orig || typeof orig !== "object") return orig;
  const g = got && typeof got === "object" ? got : {};
  const out = { ...orig };
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const choices = Array.isArray(orig.choices) ? orig.choices : [];
  const openList = [...(Array.isArray(g.openAnswers) ? g.openAnswers : []), g.openAnswer]
    .map((a) => String(a ?? "").trim())
    .filter(Boolean);
  const pickedTexts = (Array.isArray(g.correct) ? g.correct : [])
    .map((i) => (Array.isArray(g.choices) ? g.choices[i]?.text : undefined))
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
  if (orig.type === "Cm" || orig.type === "Cs") {
    const sameShape = g.type === orig.type && (!Array.isArray(g.choices) || !g.choices.length || g.choices.length === choices.length);
    let idx;
    if (sameShape && Array.isArray(g.correct)) {
      idx = g.correct.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < choices.length);
    } else {
      const want = new Set([...pickedTexts, ...openList].map(norm));
      idx = choices.map((c, i) => (want.has(norm(c?.text)) ? i : -1)).filter((i) => i >= 0);
    }
    out.correct = orig.type === "Cm" ? idx.slice(0, 1) : [...new Set(idx)];
    return out;
  }
  if (orig.type === "Co" || orig.type === "Cd") {
    const answers = [...new Set(openList.length ? openList : pickedTexts)];
    out.openAnswers = answers;
    out.openAnswer = answers[0] || "";
    return out;
  }
  if (orig.type === "Cma") {
    if (Array.isArray(g.pairs) && Array.isArray(orig.pairs) && g.pairs.length === orig.pairs.length) {
      out.pairs = orig.pairs.map((p, k) => ({ ...p, right: String(g.pairs[k]?.right ?? "") }));
    }
    return out;
  }
  return out;
}

/* ---------- request fidelity ---------- */

// "20 sual", "sual sayı 25", "15 test" → 20 / 25 / 15 (1..100); null when unstated.
const parseRequestedCount = (prompt) => {
  const s = String(prompt || "");
  const nums = [];
  const push = (v) => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 100) nums.push(n);
  };
  let m;
  const re1 = /(\d{1,3})\s*(?:dənə|ədəd|dən)?\s*(?:sual|test|tapşırıq|question)/gi;
  while ((m = re1.exec(s))) push(m[1]);
  const re2 = /(?:sual\s*say[ıiİI]|question\s*count|ne[çc]ə\s*sual)[^\d]{0,8}(\d{1,3})/gi;
  while ((m = re2.exec(s))) push(m[1]);
  // "6 qapalı və 2 açıq sual" is 8, not 2: add the parts when several are listed.
  const parts = [...s.matchAll(/(\d{1,3})\s*(?:dənə\s*)?(?:qapalı|açıq|test|uyğunluq|çoxseçimli|həlli\s*tələb\s*olunan)/gi)].map((x) => parseInt(x[1], 10));
  if (parts.length >= 2) {
    const sum = parts.reduce((a, b) => a + b, 0);
    if (sum >= 1 && sum <= 100) return sum;
  }
  return nums.length ? nums[0] : null;
};

const questionKey = (q) => String(q?.text || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);

/* ---------- prompts ---------- */

// The critic for questions the AI wrote. Same shape back, same count and order.
const REVIEW_SYSTEM_PROMPT = `Sən imtahan suallarını YOXLAYAN və DÜZƏLDƏN təcrübəli AI redaktorsan. Sənə hazır suallar (JSON) verilir. Vəzifən: hər sualı diqqətlə oxu, SƏHVLƏRİ tap və düzəlt. Nəticəni YALNIZ verilən JSON sxemi ilə, EYNİ SAYDA və EYNİ ARDICILLIQLA qaytar (heç bir sualı silmə və əlavə etmə).

DİQQƏTLƏ YOXLA VƏ DÜZƏLT:
1. DÜZGÜN CAVAB: "correct" massivində göstərilən variant həqiqətən düzgündürmü? Riyazi/məntiqi sualları ÖZÜN HƏLL ET və cavabı yoxla. Səhvdirsə, düzgün variantın indeksinə dəyiş.
2. TƏK SEÇİM (Cm): variantlardan YALNIZ BİRİ düzgün olmalıdır. Bir neçəsi düzgündürsə, ya sualı dəqiqləşdir, ya variantları düzəlt ki, yalnız biri düzgün qalsın.
3. ÇOX SEÇİM (Cs): BÜTÜN düzgün variantların indeksi "correct" massivində olmalıdır.
4. Düzgün cavab qeyd olunmayıbsa (boş "correct"), düzgün variantı tapıb qeyd et.
5. DISTRAKTORLAR: yanlış variantlar aydın yanlış, amma inandırıcı olmalıdır. Təkrarlanan, boş və ya açıq-aşkar absurd variantları düzəlt.
6. AÇIQ suallar (Co/Cd): "openAnswers" düzgün və tam olmalıdır — şagirdin yaza biləcəyi bütün formalar. Cavab səhvdirsə düzəlt.
6a. ⛔ AÇIQ-UÇLU AÇIQ SUALI DÜZƏLT: Əgər bir açıq (Co) sualın ÇOX SAYDA fərqli düzgün cavabı ola bilərsə, bu SƏHVDİR. Tipi «Cm» et, sualı saxla və 4-5 variant qur (biri düzgün — mövcud openAnswers-dən birini götür), "correct"-ə düzgün indeksi yaz, "openAnswers"-i boşalt. (Cavab əslən yeganədirsə — hesablanmış ədəd, konkret termin — Co qalsın.)
6b. ⛔ TƏSVİR/MÜNASİBƏT CAVABLI AÇIQ SUAL: cavab bir ANLAYIŞ, MÜNASİBƏT, BƏRABƏRSİZLİK və ya CÜMLƏdirsə (məs. «D<0», «mənfidir», sual «...necədir?» şəklindədir) — tipi «Cm» et, mövcud cavabı düzgün variant kimi saxla, 4-5 variant qur, "correct"-ə indeksi yaz, "openAnswers"-i boşalt.
7. UYĞUNLUQ (Cma): hər nömrənin düzgün hərfi olmalıdır; nömrələnmiş və hərflənmiş siyahılar sualın "text" hissəsində tam görünməlidir.
8. DİL və AYDINLIQ: sual birmənalı olmalıdır. İki cür başa düşülən sualı dəqiqləşdir.
9. RİYAZİYYAT DELİMİTERLƏRİ: mətndə və seçimlərdə HƏR düstur/ifadə tək dollar işarələri arasında olmalıdır — $...$ (məs. "$\\\\frac{5}{7}$", "$x^2+1$"). $...$-siz açıq LaTeX-i $...$ içinə al; balanssız $ varsa düzəlt. "latex" sahəsi həmişə "". Adi rəqəm/aralıq (20–30) $ ilə YAZILMIR.
10. Sual ARTIQ DÜZGÜNDÜRSƏ, ona TOXUNMA — yalnız real səhvləri düzəlt.
11. LANGUAGE: Preserve each question's original language. Do not translate while reviewing.

Cavabında bütün sualları (düzəldilmiş və toxunulmamış) tam qaytar.`;

// The solver for the TEACHER'S paper: answers only, nothing else changes.
const SOLVE_SYSTEM_PROMPT = `Sən imtahan suallarının CAVABINI tapan sistemsən. Sualları müəllim yazıb — sən yalnız düzgün cavabı müəyyən edirsən.

QƏTİ QAYDALAR:
- Sualın TİPİNİ ("type"), MƏTNİNİ ("text"), VARİANTLARINI ("choices"), onların sırasını və sualların SAYINI DƏYİŞMƏ. Heç bir sualı başqa tipə çevirmə, yeni variant əlavə etmə, variant silmə.
- Yalnız cavab sahələrini doldur:
  • Tək seçim (Cm): "correct" = düzgün variantın indeksi (0-dan başlayır), bir element.
  • Çox seçim (Cs): "correct" = BÜTÜN düzgün variantların indeksləri.
  • Açıq sual (Co / Cd): "openAnswers" = düzgün cavabın şagirdin klaviaturada yaza biləcəyi BÜTÜN ekvivalent formaları (düz mətn, $ YOX: məs. ["3/4","0,75","0.75"]); "openAnswer" = əsas forma. Açıq sualı HEÇ VAXT Cm-ə çevirmə, "correct"-ə indeks YAZMA.
  • Uyğunluq (Cma): hər nömrə üçün "pairs[i].right"-a düzgün hərf(lər)i yaz (bir neçədirsə vergüllə: "a, d"); "left"-i dəyişmə.
- ŞƏKİLLƏR: sənəd əlavə olunubsa, suala aid şəkil/diaqram/qrafikə BAX və rəqəmləri oradan oxu. Təxmin etmə — hesabla və ya şəkildən oxu.
- Riyazi sualları ÖZÜN addım-addım həll et və cavabı yoxla.
- Şəkil lazımdırsa, amma görə bilmirsənsə, həmin sualın cavab sahələrini BOŞ burax — cavab uydurma.
- "latex" sahəsi həmişə "" olsun; riyaziyyat mətnin içində $...$ arasındadır.

Cavab yalnız JSON olsun və bütün sualları eyni sıra ilə qaytarsın.`;

module.exports = {
  cleanQuestions,
  hasMathLeak,
  auditQuestions,
  unansweredIndexes,
  answerOnly,
  parseRequestedCount,
  questionKey,
  REVIEW_SYSTEM_PROMPT,
  SOLVE_SYSTEM_PROMPT,
};
