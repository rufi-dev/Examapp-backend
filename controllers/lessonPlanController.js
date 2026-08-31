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

const listPlans = asyncHandler(async (req, res) => {
  const plans = await LessonPlan.find({ owner: req.user._id })
    .select("title topic grade subject status revision activeVersionNumber archivedAt updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  res.json({ plans });
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
  await svc.deleteDraft(req.params.id, req.user._id);
  res.json({ deleted: true });
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
const generatePlan = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  const { runDocument } = require("../helper/aiDocument");
  const { buildLessonPlanPrompt, normalizeLessonPlan, validateCitations } = content;
  const hasSource = Boolean((plan.sourceVersions || []).length);
  const { system, prompt } = buildLessonPlanPrompt({
    hasSource,
    topic: plan.topic,
    grade: plan.grade,
    subject: plan.subject,
    subStandards: plan.subStandards || [],
    lessonMinutes: plan.lessonMinutes,
    instructions: req.body.instructions,
  });
  const { LESSON_PLAN_SCHEMA, LESSON_PLAN_GEMINI_SCHEMA } = require("../helper/lessonPlanSchema");
  const out = await runDocument({
    prompt,
    parts: [],
    system,
    schema: LESSON_PLAN_SCHEMA,
    geminiSchema: LESSON_PLAN_GEMINI_SCHEMA,
    model: req.body.model,
  });
  const normalized = normalizeLessonPlan(out.doc, { lessonMinutes: plan.lessonMinutes });
  const checked = validateCitations(normalized, {
    hasSource,
    allowedSubStandards: new Set(plan.subStandards || []),
  });
  // Never an in-place overwrite: the teacher gets a proposal and a diff.
  const proposal = await svc.proposeRegeneration(plan._id, req.user._id, checked.plan, {
    provider: out.provider,
    issues: checked.issues,
  });
  res.json({ ...proposal, issues: checked.issues, provider: out.provider });
});

/*
 * POST /:id/worksheet — the document's "iki variantda iş vərəqi generatoru".
 *
 * Derived from the plan's own tasks, never generated again: variant B perturbs the
 * approved variables of each task's server-owned template and recomputes with the
 * pinned evaluator. No AI call, no credit, and no possibility of the worksheet
 * disagreeing with the plan. Tasks with no formal model come back flagged for the
 * teacher rather than silently duplicated.
 */
const worksheet = asyncHandler(async (req, res) => {
  const plan = await mine(req, req.params.id);
  const { buildWorksheet } = require("../helper/worksheetVariants");
  const out = buildWorksheet(plan.tasks || []);
  res.json({
    title: plan.title,
    topic: plan.topic,
    criteria: plan.criteria || [],
    variants: { A: out.A, B: out.B },
    unvaried: out.unvaried,
    variedCount: out.variedCount,
  });
});

module.exports = {
  worksheet,
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
