/*
 * Lesson plans: CRUD with revision CAS, immutable publish, projector/print views,
 * and the AI generation entry point.
 *
 * `ai.generate.lessonplan` is DECLARED BUT NOT PRICED, so the generate route is
 * wired and testable while `requireActiveOperation` refuses every request with a
 * stable 503. It must never generate for free.
 */
const asyncHandler = require("express-async-handler");
const LessonPlan = require("../models/lessonPlanModel");
const LessonPlanVersion = require("../models/lessonPlanVersionModel");
const svc = require("../services/lessonPlanService");
const content = require("../helper/lessonPlanContent");
const { httpError } = require("../utils/appError");

const mine = async (req, id) => {
  const plan = await LessonPlan.findById(id);
  if (!plan) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
  if (!(String(plan.owner) === String(req.user._id) || req.user.role === "admin")) {
    throw httpError(403, "not_owner", "Bu plan sizə aid deyil.");
  }
  return plan;
};

/*
 * The list card could only show a title and a status, so every plan looked alike
 * and none of them said whether it was actually finished. The counts come from an
 * aggregation rather than loading the documents: a plan carries its tasks WITH
 * worked solutions, and shipping all of that to render "6 tapşırıq" would send
 * hundreds of kilobytes to draw one number.
 */
const listPlans = asyncHandler(async (req, res) => {
  const plans = await LessonPlan.aggregate([
    { $match: { owner: req.user._id } },
    { $sort: { updatedAt: -1 } },
    {
      $project: {
        title: 1, topic: 1, grade: 1, subject: 1, status: 1, revision: 1,
        activeVersionNumber: 1, archivedAt: 1, updatedAt: 1, lessonMinutes: 1,
        taskCount: { $size: { $ifNull: ["$tasks", []] } },
        stageCount: { $size: { $ifNull: ["$stages", []] } },
        objectiveCount: {
          $size: {
            $filter: { input: { $ifNull: ["$objectives", []] }, as: "o", cond: { $ne: ["$$o", ""] } },
          },
        },
        hasSource: { $gt: [{ $size: { $ifNull: ["$sourceVersions", []] } }, 0] },
        // How many tasks still carry a worked solution — the difference between a
        // plan you can teach from and one you still have to finish.
        solvedCount: {
          $size: {
            $filter: {
              input: { $ifNull: ["$tasks", []] },
              as: "t",
              cond: { $and: [{ $ne: ["$$t.solution", ""] }, { $ne: ["$$t.solution", null] }] },
            },
          },
        },
      },
    },
  ]);
  res.json({ plans });
});

/*
 * POST /:id/duplicate — the same lesson for another class or another year.
 *
 * Teachers re-run a plan constantly with small changes, and the only way to do it
 * was to generate a new one and pay for the AI call again. The copy is a plain
 * draft: no published version, no proposal, and the pinned chapter comes with it so
 * a regeneration still has its source.
 */
const duplicatePlan = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  const src = plan.toObject();
  for (const k of ["_id", "createdAt", "updatedAt", "__v", "proposal", "activeVersionNumber", "archivedAt", "revision", "status", "planCapEnforcedAt"]) {
    delete src[k];
  }
  const copy = await LessonPlan.create({
    ...src,
    title: `${plan.title} (nüsxə)`,
    owner: req.user._id,
    ownerName: req.user.name || "",
    status: "draft",
    revision: 0,
  });
  res.status(201).json({ plan: copy });
});

const createPlan = asyncHandler(async (req, res) => {
  const plan = await LessonPlan.create({
    owner: req.user._id,
    ownerName: req.user.name || "",
    title: content.clean(req.body.title) || "Yeni dərs planı",
    grade: content.clean(req.body.grade),
    subject: content.clean(req.body.subject),
    topic: content.clean(req.body.topic),
    subStandards: content.cleanList(req.body.subStandards),
    lessonMinutes: Number(req.body.lessonMinutes) || 45,
    // A new plan is a PRIVATE DRAFT. `classes: []` is not "all students" here.
    status: "draft",
    classes: undefined,
  });
  res.status(201).json({ plan });
});

const getPlan = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  const versions = await LessonPlanVersion.find({ docId: plan._id })
    .select("versionNumber contentHash publishedAt")
    .sort({ versionNumber: -1 })
    .lean();
  res.json({ plan, versions });
});

const updatePlan = asyncHandler(async (req, res) => {
  await mine(req, req.params.id);
  const body = req.body || {};
  const patch = {};
  for (const f of svc.CONTENT_FIELDS) {
    if (body[f] === undefined) continue;
    if (["objectives", "criteria", "subStandards", "materials"].includes(f)) patch[f] = content.cleanList(body[f]);
    else if (f === "stages" || f === "tasks") patch[f] = content.normalizeLessonPlan({ [f]: body[f] })[f];
    else if (f === "lessonMinutes") patch[f] = Number(body[f]) || 45;
    else if (f === "sourceMode" || f === "motivationOrigin") patch[f] = body[f];
    else patch[f] = content.clean(body[f]);
  }
  // Releasing solutions is a STATE change, not a content edit, but it rides the
  // same revision CAS so it cannot silently overwrite a concurrent edit.
  if (body.solutionsReleased !== undefined) patch.solutionsReleased = body.solutionsReleased === true;
  const plan = await svc.updateDraft(req.params.id, req.user._id, patch, body.revision);
  res.json({ plan, duration: content.validateDuration(plan) });
});

const setSources = asyncHandler(async (req, res) => {
  await mine(req, req.params.id);
  const ids = Array.isArray(req.body.sourceVersions) ? req.body.sourceVersions : [];
  const plan = await svc.setSources(req.params.id, req.user._id, ids);
  res.json({ plan });
});

const publishPlan = asyncHandler(async (req, res) => {
  await mine(req, req.params.id);
  const version = await svc.publish(req.params.id, req.user._id);
  res.json({ version: { _id: version._id, versionNumber: version.versionNumber, contentHash: version.contentHash } });
});

const archivePlan = asyncHandler(async (req, res) => {
  await mine(req, req.params.id);
  const plan = await svc.archive(req.params.id, req.user._id, req.body.archived !== false);
  res.json({ plan });
});

const deletePlan = asyncHandler(async (req, res) => {
  await mine(req, req.params.id);
  // Destroying a PUBLISHED plan takes an explicit force flag, so nothing can wipe
  // published content by accident. Unpublished drafts delete without ceremony.
  const out = await svc.deleteDraft(req.params.id, req.user._id, {
    actor: req.user.email || String(req.user._id),
    force: req.query.force === "published",
  });
  res.json({ deleted: true, versionsRemoved: out.versionsRemoved || 0 });
});

const acceptProposal = asyncHandler(async (req, res) => {
  await mine(req, req.params.id);
  const plan = await svc.acceptProposal(req.params.id, req.user._id, req.body.revision);
  res.json({ plan });
});

/*
 * The teacher's projector view reads the FROZEN version, so what is on screen is
 * exactly what was published — never a half-edited draft.
 */
const projectorView = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  if (!plan.activeVersion) throw httpError(409, "not_published", "Əvvəlcə planı dərc edin.");
  const version = await LessonPlanVersion.findById(plan.activeVersion).lean();
  res.json({ version: version.versionNumber, contentHash: version.contentHash, content: version.content });
});

/*
 * The STUDENT view. Solutions are withheld by role AND document state on the
 * server — "Yoxla" in the teacher's projector view is a UI affordance over data a
 * student never receives.
 */
const studentPlanView = asyncHandler(async (req, res) => {
  const plan = await LessonPlan.findById(req.params.id).lean();
  if (!plan || !plan.activeVersion) throw httpError(404, "plan_missing", "Dərs planı tapılmadı.");
  const shared = Array.isArray(plan.classes) && plan.classes.length > 0;
  if (!shared) throw httpError(403, "not_shared", "Bu plan paylaşılmayıb.");
  const version = await LessonPlanVersion.findById(plan.activeVersion).lean();
  // Two independent conditions, both server-side: the plan must be published AND
  // the teacher must have released solutions.
  const released = plan.status === "published" && plan.solutionsReleased === true;
  res.json({ plan: content.studentView(version.content, { released }) });
});

/*
 * POST /:id/generate — refused while the operation is unpriced.
 * requireActiveOperation("ai.generate.lessonplan") sits in front of this in the
 * router, so this handler is currently unreachable; it is written and wired so the
 * only remaining work when the owner sets a price is flipping `active: true`.
 */
/*
 * Caps on what can be handed to a provider in one request. A whole 200MB textbook
 * cannot go into a prompt, and pretending otherwise produces exactly the failure
 * this endpoint had: the model is told it has a book, given nothing, and invents a
 * page number.
 */
const MAX_SOURCE_PROMPT_MB = Number(process.env.LESSON_PLAN_MAX_SOURCE_MB) || 20;
const MAX_SOURCE_PROMPT_PAGES = Number(process.env.LESSON_PLAN_MAX_SOURCE_PAGES) || 60;

/*
 * POST /:id/generate
 *
 * When a chapter is attached its BYTES are sent with the prompt, and every page it
 * claims afterwards is checked against that file. Previously `parts` was always
 * empty while the prompt still said "MƏNBƏ VAR", so the model was told it had a
 * textbook, handed nothing, and produced citations to pages that do not exist.
 */
const runPlanGeneration = async (req, res, buildPrompt) => {
  const plan = await mine(req, req.params.id);
  const { runDocument } = require("../helper/aiDocument");
  const { LESSON_PLAN_SCHEMA, LESSON_PLAN_GEMINI_SCHEMA } = require("../helper/lessonPlanSchema");
  const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
  const storage = require("../helper/curriculumStorage");
  const evidence = require("../helper/curriculumEvidence");
  const geometry = require("../helper/curriculumGeometry");
  const fsp = require("fs").promises;

  // ---- attach the chapter, if one is pinned ----
  const parts = [];
  let sourceVersion = null;
  if ((plan.sourceVersions || []).length) {
    sourceVersion = await CurriculumSourceVersion.findById(plan.sourceVersions[0]);
    if (!sourceVersion || !["ready", "superseded"].includes(sourceVersion.state)) {
      throw httpError(409, "source_unavailable", "Bağlanmış dərslik faylı əlçatan deyil.");
    }
    if (sourceVersion.pageCount > MAX_SOURCE_PROMPT_PAGES) {
      throw httpError(
        413,
        "source_too_long",
        `Bu dərslik ${sourceVersion.pageCount} səhifədir — bir sorğuya sığmır. Yalnız lazım olan fəsli (ən çox ${MAX_SOURCE_PROMPT_PAGES} səhifə) ayrıca yükləyin.`
      );
    }
    if (sourceVersion.bytes > MAX_SOURCE_PROMPT_MB * 1024 * 1024) {
      throw httpError(413, "source_too_large", `Fayl ${MAX_SOURCE_PROMPT_MB}MB-dan böyükdür.`);
    }
    // Read the PINNED bytes and confirm they are the ones the plan pinned.
    const file = storage.pathForKey(sourceVersion.storageKey, sourceVersion.ext);
    const intact = await storage.verifyBytes(sourceVersion.storageKey, sourceVersion.ext, sourceVersion.sha256);
    if (!intact.ok) throw httpError(409, "source_bytes_changed", "Dərslik faylı dəyişib və ya itib.");
    parts.push({ mime: "application/pdf", data: (await fsp.readFile(file)).toString("base64"), isPdf: true });
  }

  const hasSource = parts.length > 0;
  const { system, prompt } = buildPrompt(plan, hasSource);

  const out = await runDocument({
    prompt,
    parts,
    system,
    schema: LESSON_PLAN_SCHEMA,
    geminiSchema: LESSON_PLAN_GEMINI_SCHEMA,
    model: req.body.model,
  });

  const normalized = content.normalizeLessonPlan(out.doc, { lessonMinutes: plan.lessonMinutes });
  const checked = content.validateCitations(normalized, {
    hasSource,
    allowedSubStandards: new Set(plan.subStandards || []),
  });

  /*
   * VERIFY every page the model claims, against the file it was given. A page
   * number inside the document is not acceptance: the excerpt must actually appear
   * on that page. Anything unproven loses its citation rather than being printed as
   * fact — a wrong "səh. 124" on a teacher's paper is worse than no reference.
   */
  if (hasSource && sourceVersion) {
    const file = storage.pathForKey(sourceVersion.storageKey, sourceVersion.ext);
    const pageTextCache = new Map();
    for (const t of checked.plan.tasks) {
      const label = t.sourceEvidence && t.sourceEvidence.printedPageLabel;
      if (!label) continue;

      const idx = geometry.fileIndexForLabel(sourceVersion.pageMap, label, sourceVersion.pageCount);
      if (idx < 0) {
        // The book has no such printed page — the number was invented.
        t.sourceEvidence = undefined;
        t.sourceMode = "original";
        t.reviewStatus = "needs_teacher_review";
        t.reviewNotes = [...(t.reviewNotes || []), `Dərslikdə "${label}" səhifəsi tapılmadı — istinad silindi.`];
        checked.issues.push({ code: "citation_page_not_found", label });
        continue;
      }
      if (!pageTextCache.has(idx)) pageTextCache.set(idx, await evidence.pdfPageText(file, idx));
      const match = evidence.matchExcerpt(pageTextCache.get(idx), {
        excerpt: t.sourceEvidence.sourceExcerpt || t.sourceEvidence.excerpt,
        sourceTaskNo: t.sourceEvidence.sourceTaskNo,
      });
      t.sourceEvidence = {
        ...t.sourceEvidence,
        source: sourceVersion.source,
        sourceVersion: sourceVersion._id,
        sourceHash: sourceVersion.sha256,
        filePageIndex: idx,
        verifyStatus: match.status,
        verifyReason: match.reason || "",
      };
      if (match.status !== evidence.VERIFY_STATUS.MACHINE_MATCHED) {
        t.reviewStatus = "needs_teacher_review";
        checked.issues.push({ code: "citation_unverified", label, reason: match.reason });
      }
    }

    /*
     * Free text carries invented pages too ("125 və 126 səhifələrdəki tapşırıqlar").
     * The prose is NOT rewritten (CR-MSO-003) — it is LABELLED, because an invented
     * page printed on a teacher's handout without comment is the actual harm.
     */
    const homeworkClaims = require("../helper/curriculumEvidence").findCitationClaims(checked.plan.homework);
    const missing = [];
    for (const c of homeworkClaims) {
      const num = (c.match(/\d+/) || [])[0];
      if (num && geometry.fileIndexForLabel(sourceVersion.pageMap, num, sourceVersion.pageCount) < 0) {
        checked.issues.push({ code: "homework_page_not_found", label: num });
        if (!missing.includes(num)) missing.push(num);
      }
    }
    if (missing.length) {
      checked.plan.homeworkWarning =
        `Bu istinad yoxlanılmadı: bağlanmış faylda ${missing.map((m) => `${m}-ci`).join(", ")} ` +
        `səhifə yoxdur (fayl ${sourceVersion.pageCount} səhifədir). Ev tapşırığını özünüz dəqiqləşdirin.`;
    }

    /*
     * A task may only CLAIM the textbook if its citation was actually verified
     * against the pinned bytes. Otherwise "dərslik əsasında uyğunlaşdırılıb" is
     * provenance nothing backs — which is what printed on every task of a maths
     * plan whose attached file was a German speaking guide.
     */
    for (const t of checked.plan.tasks) {
      const verified =
        t.sourceEvidence &&
        [evidence.VERIFY_STATUS.MACHINE_MATCHED, evidence.VERIFY_STATUS.TEACHER_VERIFIED].includes(
          t.sourceEvidence.verifyStatus
        );
      if (!verified && t.sourceMode !== "original") {
        t.sourceMode = "original";
        t.reviewNotes = [
          ...(t.reviewNotes || []),
          "Dərslikdən götürüldüyü təsdiqlənmədi — mənbə göstərilmir.",
        ];
      }
    }
  }

  const usable = (normalized.stages || []).length > 0 || (normalized.tasks || []).length > 0;
  if (req.aiCredit && usable) req.aiCredit.usable();

  /*
   * APPLIED, not proposed. The propose/accept/discard round-trip was one screen of
   * buttons for a decision the teacher had already made by pressing the button, and
   * it silently stranded good output when they did not notice the panel. Targeted
   * edits keep the rest of the plan intact by construction (see the edit prompt), so
   * there is nothing to protect against here.
   */
  const patch = { ...checked.plan };
  delete patch.proposal;
  const saved = await svc.updateDraft(plan._id, req.user._id, patch, plan.revision, ["proposal"]);
  res.json({ plan: saved, issues: checked.issues, provider: out.provider, hasSource });
};

const generatePlan = asyncHandler((req, res) =>
  runPlanGeneration(req, res, (plan, hasSource) =>
    content.buildLessonPlanPrompt({
      hasSource,
      topic: plan.topic,
      grade: plan.grade,
      subject: plan.subject,
      subStandards: plan.subStandards || [],
      lessonMinutes: plan.lessonMinutes,
      instructions: req.body.instructions,
    })
  )
);

/*
 * POST /:id/edit — change ONE thing and leave the rest alone.
 *
 * Same model call and same verification as a generation; the difference is entirely
 * in the prompt, which carries the current plan and instructs that everything the
 * teacher did not ask about comes back unchanged.
 */
const editPlan = asyncHandler(async (req, res) => {
  const wanted = String((req.body && req.body.instructions) || "").trim();
  if (!wanted) throw httpError(400, "edit_empty", "Nə dəyişmək istədiyinizi yazın.");
  return runPlanGeneration(req, res, (plan, hasSource) =>
    content.buildLessonPlanEditPrompt({ plan: plan.toObject(), instructions: wanted, hasSource })
  );
});

/*
 * POST /:id/worksheet — the two-variant sheet her prompt asks for.
 *
 * Derived from the plan own tasks, never generated again: no AI call, no credit,
 * and no possibility of the worksheet disagreeing with the plan it came from.
 */
const worksheet = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  const { buildWorksheet } = require("../helper/worksheetVariants");
  // PLAIN objects: spreading a Mongoose subdocument copies its internals, not its
  // fields, so buildWorksheet would receive tasks whose statement is undefined and
  // emit a worksheet of empty numbered rows.
  const out = buildWorksheet(plan.toObject().tasks || []);
  res.json({
    title: plan.title,
    topic: plan.topic,
    criteria: plan.criteria || [],
    variants: { A: out.A, B: out.B },
    unvaried: out.unvaried,
    variedCount: out.variedCount,
    aiVaried: out.aiVaried,
    textVaried: out.textVaried,
  });
});

/*
 * POST /:id/proposal/discard
 *
 * The counterpart to accept. Without it a proposal the teacher does not want sits
 * on the plan for ever, and the only way to clear it is to accept content they
 * rejected.
 */
const discardProposal = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  plan.proposal = undefined;
  await plan.save();
  res.json({ ok: true, revision: plan.revision });
});

module.exports = {
  worksheet,
  duplicatePlan,
  editPlan,
  discardProposal,
  listPlans,
  createPlan,
  getPlan,
  updatePlan,
  setSources,
  publishPlan,
  archivePlan,
  deletePlan,
  acceptProposal,
  projectorView,
  studentPlanView,
  generatePlan,
};
