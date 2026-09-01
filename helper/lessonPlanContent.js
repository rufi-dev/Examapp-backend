/*
 * Lesson-plan content: sanitisation, normalisation, prompts and the student view.
 *
 * Content is STRUCTURED JSON, never provider-generated HTML. Rich text still
 * reaches the projector view, so every string passes sanitize-html with a strict
 * allow-list ON WRITE — an allow-list, not a blocklist, so a tag nobody thought of
 * is dropped rather than rendered.
 *
 * The schema cannot enforce counts (minItems does not exist in the strict subset),
 * so "exactly 2 objectives, 3 criteria" is enforced by prompt AND normalised here.
 * This is the enforcement point; the prompt is only the request.
 */
const sanitizeHtml = require("sanitize-html");
const { findCitationClaims } = require("./curriculumEvidence");

const ALLOWED_TAGS = ["b", "strong", "i", "em", "u", "br", "p", "ul", "ol", "li", "sub", "sup"];
const SANITIZE_OPTS = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {},
  allowedSchemes: [],
  disallowedTagsMode: "discard",
};

const clean = (s) => sanitizeHtml(String(s == null ? "" : s), SANITIZE_OPTS).trim();
const cleanList = (a) => (Array.isArray(a) ? a.map(clean).filter(Boolean) : []);

const OBJECTIVES = 2;
const CRITERIA = 3;
const MAX_STAGE_MINUTES = 90;

// Pad to `n` with "" and truncate past it. The model is ASKED for n; this is what
// guarantees it.
function fixedLength(list, n) {
  const out = cleanList(list).slice(0, n);
  while (out.length < n) out.push("");
  return out;
}

function normalizeLessonPlan(raw, { lessonMinutes = 45 } = {}) {
  const p = raw && typeof raw === "object" ? raw : {};
  const stages = (Array.isArray(p.stages) ? p.stages : [])
    .map((s) => ({
      name: clean(s && s.name),
      minutes: Math.max(0, Math.min(MAX_STAGE_MINUTES, Math.round(Number(s && s.minutes) || 0))),
      teacher: clean(s && s.teacher),
      student: clean(s && s.student),
      resources: clean(s && s.resources),
      checks: clean(s && s.checks),
      differentiation: clean(s && s.differentiation),
    }))
    // A nameless stage is not a stage; dropping it beats rendering a blank block.
    .filter((s) => s.name);

  const variantOf = (v) => {
    const statement = clean(v && v.statement);
    // A variant that repeats variant A is not a variant. Dropping it here lets the
    // worksheet fall back to shifting the numbers itself rather than printing two
    // identical papers and calling them A and B.
    if (!statement) return undefined;
    return { statement, solution: clean(v && v.solution), answer: clean(v && v.answer) };
  };

  const tasks = (Array.isArray(p.tasks) ? p.tasks : []).map((t) => ({
    statement: clean(t && t.statement),
    solution: clean(t && t.solution),
    answer: clean(t && t.answer),
    variantB: (() => {
      const b = variantOf(t && t.variantB);
      return b && b.statement !== clean(t && t.statement) ? b : undefined;
    })(),
    bloom: clean(t && t.bloom),
    sourceMode: ["verbatim", "adapted", "original"].includes(t && t.sourceMode) ? t.sourceMode : "original",
    sourceEvidence: t && t.sourceEvidence && typeof t.sourceEvidence === "object" ? t.sourceEvidence : undefined,
    reviewStatus: "pending",
    reviewNotes: undefined,
  }));

  return {
    title: clean(p.title),
    grade: clean(p.grade),
    subject: clean(p.subject),
    topic: clean(p.topic),
    subStandards: cleanList(p.subStandards),
    objectives: fixedLength(p.objectives, OBJECTIVES),
    criteria: fixedLength(p.criteria, CRITERIA),
    motivation: clean(p.motivation),
    // A hook the AI invented is labelled as such. It may never carry a citation.
    motivationOrigin: "ai",
    stages,
    tasks,
    reflection: clean(p.reflection),
    homework: clean(p.homework),
    homeworkWarning: "",
    materials: cleanList(p.materials),
    lessonMinutes,
  };
}

/*
 * CR-MSO-003 — prose is DETECTED, never rewritten.
 *
 * An earlier design stripped page-like text with a regex, which would damage a
 * legitimate task containing "kitabın 47-ci səhifəsi". Instead, when there is no
 * source, a citation claim (structured OR in prose) fails the task to
 * needs_teacher_review and the plan reports it. Nothing is edited.
 */
function validateCitations(plan, { hasSource = false, allowedSubStandards = null } = {}) {
  const issues = [];
  const out = { ...plan, tasks: (plan.tasks || []).map((t) => ({ ...t })) };

  // The strongest single anti-hallucination measure: a curriculum code the teacher
  // did not supply is dropped. "2.1.3" looks authoritative and nobody checks it.
  if (allowedSubStandards) {
    const before = out.subStandards || [];
    out.subStandards = before.filter((code) => allowedSubStandards.has(code));
    if (out.subStandards.length !== before.length) issues.push({ code: "substandard_not_allowed" });
  }

  for (const [i, t] of out.tasks.entries()) {
    const claimsInProse = [...findCitationClaims(t.statement), ...findCitationClaims(t.solution)];
    const hasStructured = Boolean(t.sourceEvidence && (t.sourceEvidence.printedPageLabel || t.sourceEvidence.sourceTaskNo));

    /*
     * "derslik esasinda uygunlasdirilib" is a claim about provenance. With no file
     * attached there is nothing it could have been adapted FROM, so the mode is
     * corrected even when the model made no explicit citation — otherwise every
     * task prints a textbook badge that nothing backs.
     */
    if (!hasSource && t.sourceMode !== "original") {
      t.sourceMode = "original";
    }

    if (!hasSource && (hasStructured || claimsInProse.length)) {
      // No source was uploaded, so no citation can possibly be real.
      t.sourceEvidence = undefined;
      t.sourceMode = "original";
      t.reviewStatus = "needs_teacher_review";
      t.reviewNotes = [
        ...(t.reviewNotes || []),
        "Mənbə yüklənmədiyi halda dərsliyə istinad iddiası var — mətn dəyişdirilmədi, yoxlayın.",
      ];
      issues.push({ code: "citation_without_source", task: i, claims: claimsInProse });
    }
  }

  const homeworkClaims = findCitationClaims(out.homework);
  if (!hasSource && homeworkClaims.length) {
    issues.push({ code: "homework_citation_without_source", claims: homeworkClaims });
  }
  // A padded-out blank renders as nothing, so a plan with 2 criteria LOOKS like it
  // met the "exactly 3" rule. Say so instead.
  if (out.objectives.filter(Boolean).length !== OBJECTIVES) {
    issues.push({ code: "objectives_count", want: OBJECTIVES, got: out.objectives.filter(Boolean).length });
  }
  if (out.criteria.filter(Boolean).length !== CRITERIA) {
    issues.push({ code: "criteria_count", want: CRITERIA, got: out.criteria.filter(Boolean).length });
  }
  const withoutSolution = (out.tasks || []).filter((t) => !t.solution).length;
  if (withoutSolution) issues.push({ code: "tasks_without_solution", count: withoutSolution });
  if (!out.reflection) issues.push({ code: "reflection_missing" });

  return { plan: out, issues };
}

// Stage minutes must add up to the lesson.
function validateDuration(plan) {
  const sum = (plan.stages || []).reduce((s, x) => s + (Number(x.minutes) || 0), 0);
  const want = Number(plan.lessonMinutes) || 45;
  return { ok: sum === want, sum, want };
}

/*
 * TWO system prompts chosen SERVER-SIDE, never one prompt with a conditional the
 * model may skim past. Phrased positively ("always write ''") — models comply with
 * that far more reliably than with a bare prohibition.
 */
const NO_SOURCE_RULES = `
MƏNBƏ YOXDUR: bu sorğuya HEÇ BİR dərslik faylı əlavə edilməyib.
- "printedPageLabel" HƏMİŞƏ "" olmalıdır. "sourceTaskNo" HƏMİŞƏ "" olmalıdır.
- "sourceExcerpt" HƏMİŞƏ "" olmalıdır. "sourceMode" HƏMİŞƏ "original" olmalıdır.
- Dərsliyin səhifəsinə, çalışma nömrəsinə və ya "X kitabının Y səhifəsi" kimi
  istinada ASLA yazma — nə tapşırıq mətnində, nə həlldə, nə də ev tapşırığında.
- Ev tapşırığını MƏZMUNLA təsvir et ("kvadrat tənliklərə dair 5 məsələ həll et"),
  səhifə/nömrə ilə YOX.`;

const WITH_SOURCE_RULES = `
DƏRSLİK ÜSTÜNDÜR: müəllim fəsil yükləyib və o fayl BİRİNCİ mənbədir.
- Tapşırıqları ÖZÜN QURMA — faylda olan çalışmaları götür. Müəllimin mətndəki
  göstərişi mövzunu və səviyyəni müəyyən edir, tapşırıqların MƏNBƏYİNİ yox.
- Faylda mövzuya uyğun çalışma tapmasan, tapşırıq UYDURMA: həmin tapşırığı yazma
  və ya sourceMode="original" qoyub bütün istinad sahələrini boş saxla. Serverdə
  hər səhifə fayl ilə yoxlanılır, uydurulmuş nömrə silinir.

MƏNBƏ VAR: yüklənmiş fəsil/şəkillər YEGANƏ istinad mənbəyidir.
- "printedPageLabel" = tapşırığın GÖRÜNDÜYÜ səhifənin ÜZƏRİNDƏ ÇAP OLUNMUŞ nömrə
  (mətn kimi: "124", "iv", "A-12"). Səhifədə nömrə görünmürsə "" yaz —
  fayldakı SIRASINI SAYMA.
- "sourceTaskNo" = çap olunmuş çalışma nömrəsi ("12", "12a"); yoxdursa "".
- "sourceExcerpt" = həmin səhifədən OXUDUĞUN mətndən ən azı 40 simvolluq DƏQİQ parça
  (server onu faylla tutuşduracaq). Uydurma.
- Sənəddə OLMAYAN, özün yaratdığın tapşırıq üçün: sourceMode="original" və bütün
  istinad sahələri "".`;

/*
 * The teacher's own prompt asks for a great deal that a thin plan does not deliver:
 * exactly 2 objectives and exactly 3 criteria, tasks she can actually run a lesson
 * from, a WORKED SOLUTION behind every "Yoxla", invented example tasks on the
 * motivation sheet ("nümunə üçün tapşırıqları özün uydur"), and explicit attention
 * to reflection and assessment. Ask for all of it, in the order she wrote it.
 */
const TASK_COUNT_MIN = Number(process.env.LESSON_PLAN_MIN_TASKS) || 6;
const TASK_COUNT_MAX = Number(process.env.LESSON_PLAN_MAX_TASKS) || 8;

const BASE_RULES = `
Sən Azərbaycan kurikulumu üzrə DƏRS PLANI hazırlayan təcrübəli metodistsən.
Cavabı YALNIZ verilmiş JSON sxemi ilə qaytar. Bütün mətn Azərbaycan dilində olsun.
Plan lövhəyə proyeksiya ediləcək və çap olunacaq — mətnlər aydın, tam cümlələrlə,
müəllimin dərsdə oxuyub tətbiq edə biləcəyi səviyyədə olsun.

MƏCBURİ SAYLAR (pozulması qəbul edilmir):
- "objectives": DƏQİQ 2 ədəd. Hər biri ölçülə bilən nəticə ("...bacarığını inkişaf
  etdirmək" yox, "...hesablayır və tənliyi yazır" kimi konkret davranış).
- "criteria": DƏQİQ 3 ədəd — nə 2, nə 4. Hər meyar "Şagird ... bacarır" formasında,
  bir-birindən fərqli və yoxlanıla bilən olsun.
- "tasks": ${TASK_COUNT_MIN}–${TASK_COUNT_MAX} ədəd, çətinliyi TƏDRİCƏN artan.
  RƏNGARƏNGLİK MƏCBURİDİR: tapşırıqlar bir-birinin təkrarı olmasın. Rəqəmləri elə
  seç ki, NƏTİCƏLƏR də fərqli çıxsın — eyni cavabı (məsələn hamısında eyni bucaq
  əmsalı) təkrarlama. Müsbət, mənfi, sıfır və kəsr hallarını qarışdır; sonuncu
  1–2 tapşırıq isə xüsusi/istisna halı yoxlasın.
- "stages": 4–6 mərhələ; "minutes" cəmi dərsin müddətinə BƏRABƏR olsun.

HƏR TAPŞIRIQ ÜÇÜN:
- "statement": konkret rəqəmlərlə, tam şəkildə yazılmış tapşırıq.
- "solution": ADDIM-ADDIM tam həll — düstur, əvəzetmə və nəticə. Müəllim bunu
  "Yoxla" düyməsi ilə lövhədə açacaq, ona görə yalnız cavab yazmaq KİFAYƏT DEYİL.
- "answer": YALNIZ son cavab, qısa (məsələn "k = 2, y = 2x" və ya "V = 60 sm³").
- "bloom": tapşırığın Blum səviyyəsi.
- "variantB": EYNİ tapşırığın İKİNCİ variantı — yan-yana oturan şagird köçürə
  bilməsin deyə. Qaydalar:
  * "statement": eyni tip, eyni çətinlik, eyni ifadə tərzi — YALNIZ rəqəmlər/verilənlər
    fərqli. Yeni mövzu, əlavə addım və ya daha çətin hal GƏTİRMƏ.
  * "solution": bu YENİ rəqəmlərlə addım-addım tam həll. Variant A-nın həllini
    təkrarlama — hesablamaları yenidən apar.
  * "answer": bu yeni rəqəmlərlə son cavab.
  * Rəqəmləri elə seç ki, tapşırığın MƏNASI pozulmasın: məsələn iki nöqtədən keçən
    xətt tapşırığında hər iki nöqtənin absisi eyni olarsa xətt şaquli olur və bucaq
    əmsalı yoxdur — bu halda rəqəmləri başqa cür seç.
  * Söz tapşırığında (rəqəm yoxdursa) verilənləri dəyiş: ad, kontekst, ölçü.

HƏR MƏRHƏLƏ ÜÇÜN:
- "teacher" və "student": kimin nə etdiyi, ayrı-ayrılıqda.
- "resources": istifadə olunan vasitələr.
- "checks": həmin mərhələdə öyrənmənin NECƏ yoxlandığı (sual, qısa tapşırıq, müşahidə).
- "differentiation": çətinlik çəkən və irəli gedən şagird üçün nə dəyişir.

MOTİVASİYA:
- "motivation" həm qısa maraq oyadan giriş, HƏM DƏ nümunə üçün 1–2 sadə tapşırıq
  ehtiva etsin — bunları özün uydur, sırf lövhədə göstərmək üçün.

REFLEKSİYA VƏ QİYMƏTLƏNDİRMƏ (xüsusi diqqət):
- "reflection": dərsin sonunda veriləcək 2–3 konkret sual VƏ hər qiymətləndirmə
  meyarının necə yoxlanacağı. Ümumi ifadələr ("şagirdlər fikirlərini bildirir")
  yazma — konkret sual və konkret yoxlama üsulu yaz.
- "homework": məzmunu ilə təsvir olunmuş konkret ev tapşırığı.
- "materials": dərsdə lazım olan bütün vasitələrin siyahısı.

TERMİNOLOGİYA:
- Azərbaycan məktəb dərsliklərində işlənən STANDART terminlərdən istifadə et.
  İngilis terminini hərfi tərcümə etmə (məsələn "slope" üçün "kəskinlik" YOX,
  "bucaq əmsalı" düzgündür). Əmin olmadığın halda terminin əvəzinə anlayışı
  izah edən sadə ifadə yaz.

- "subStandards" massivinə YALNIZ müəllimin verdiyi kodları yaz; yeni kod UYDURMA.`;

function buildLessonPlanPrompt({ hasSource = false, topic = "", grade = "", subject = "", subStandards = [], lessonMinutes = 45, instructions = "" } = {}) {
  const system = [BASE_RULES, hasSource ? WITH_SOURCE_RULES : NO_SOURCE_RULES].join("\n");
  const prompt = [
    `Mövzu: ${topic || "(qeyd olunmayıb)"}`,
    `Sinif: ${grade || "(qeyd olunmayıb)"}`,
    `Fənn: ${subject || "(qeyd olunmayıb)"}`,
    `Dərsin müddəti: ${lessonMinutes} dəqiqə`,
    subStandards.length ? `Alt-standartlar (YALNIZ bunlar): ${subStandards.join(", ")}` : "Alt-standart verilməyib: massivi boş saxla.",
    `Tapşırıq sayı: ${TASK_COUNT_MIN}–${TASK_COUNT_MAX}, hər birinin addım-addım həlli ilə.`,
    hasSource
      ? "Tapşırıqları YÜKLƏNMİŞ dərslikdən götür və hər biri üçün səhifə ilə çalışma nömrəsini yaz."
      : "Dərslik yüklənməyib: tapşırıqları özün qur, lakin heç bir səhifə/nömrə istinadı yazma.",
    instructions ? `Müəllimin əlavə göstərişi: ${String(instructions).slice(0, 2000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { system, prompt };
}

/*
 * What a STUDENT may receive. An allow-list, enforced by role AND document state on
 * the server — never a UI toggle. `solution` and `rubric` are withheld until the
 * plan is published AND the teacher has released solutions.
 */
function studentView(plan, { released = false } = {}) {
  return {
    title: plan.title,
    topic: plan.topic,
    grade: plan.grade,
    subject: plan.subject,
    objectives: plan.objectives,
    criteria: plan.criteria,
    motivation: plan.motivation,
    stages: (plan.stages || []).map((s) => ({ name: s.name, minutes: s.minutes, student: s.student })),
    tasks: (plan.tasks || []).map((t) => ({
      statement: t.statement,
      // Withheld until released. Citations are teacher documentation and never
      // travel to a student, so a hallucinated page cannot reach the paper.
      ...(released ? { solution: t.solution } : {}),
    })),
    homework: plan.homework,
    materials: plan.materials,
  };
}

module.exports = {
  ALLOWED_TAGS,
  OBJECTIVES,
  CRITERIA,
  TASK_COUNT_MIN,
  TASK_COUNT_MAX,
  clean,
  cleanList,
  fixedLength,
  normalizeLessonPlan,
  validateCitations,
  validateDuration,
  buildLessonPlanPrompt,
  studentView,
  NO_SOURCE_RULES,
  WITH_SOURCE_RULES,
};
