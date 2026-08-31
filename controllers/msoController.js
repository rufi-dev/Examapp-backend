/*
 * MSO: the blueprint, generation, review and publish.
 *
 * The paper's SHAPE is data. A blueprint is seeded from a preset in
 * config/msoPresets.js and owned by the teacher afterwards, so a 15-, 20- or
 * 12-task assessment all work without a code change. The default is the structure
 * the teacher's own prompt document specifies: 15 tasks, 1-11 closed with four
 * options and one correct answer, 12-15 open, and a ladder summing to exactly 100.
 *
 * `POST /:id/generate` answers 422 naming any row whose type, points, grading mode
 * or Bloom level is still undecided — it never copies a neighbouring row's rules
 * and never fabricates a points distribution.
 */
const asyncHandler = require("express-async-handler");
const MsoBlueprint = require("../models/msoBlueprintModel");
const MsoDocument = require("../models/msoDocumentModel");
const MsoVersion = require("../models/msoVersionModel");
const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
const validators = require("../helper/msoValidators");
const { withMongoTransaction } = require("../services/mongoUnitOfWork");
const { publishWithRetry } = require("../helper/immutableVersion");
const { claimNew, transferHolder } = require("../services/curriculumSourceService");
const { httpError } = require("../utils/appError");
const { buildRows, isPreset, DEFAULT_PRESET, presetIds, presetSummary, PRESETS } = require("../config/msoPresets");

const mineBlueprint = async (req, id) => {
  const bp = await MsoBlueprint.findById(id);
  if (!bp) throw httpError(404, "blueprint_missing", "Blueprint tapılmadı.");
  if (!(String(bp.owner) === String(req.user._id) || req.user.role === "admin")) {
    throw httpError(403, "not_owner", "Bu blueprint sizə aid deyil.");
  }
  return bp;
};

// The structures the UI can offer. Data, so a new shape needs no code change here.
const listPresets = asyncHandler(async (req, res) => {
  res.json({ presets: presetIds().map(presetSummary), default: DEFAULT_PRESET });
});

const listBlueprints = asyncHandler(async (req, res) => {
  const blueprints = await MsoBlueprint.find({ owner: req.user._id })
    .select("title grade subject totalPoints revision updatedAt")
    .sort({ updatedAt: -1 })
    .lean();
  res.json({ blueprints });
});

const createBlueprint = asyncHandler(async (req, res) => {
  const presetId = isPreset(req.body.presetId) ? req.body.presetId : DEFAULT_PRESET;
  const bp = await MsoBlueprint.create({
    owner: req.user._id,
    title: String(req.body.title || "Yeni MSO").slice(0, 300),
    grade: String(req.body.grade || ""),
    subject: String(req.body.subject || ""),
    standard: String(req.body.standard || ""),
    subStandards: Array.isArray(req.body.subStandards) ? req.body.subStandards.map(String) : undefined,
    textbookEdition: String(req.body.textbookEdition || ""),
    presetId,
    rowCount: PRESETS[presetId].rowCount,
    rows: buildRows(presetId),
    // Seeded only when the preset actually states a total. A preset that leaves
    // rows undecided leaves the total undecided too — the ladder cannot be known
    // before the rows are.
    totalPoints: PRESETS[presetId].totalPoints,
  });
  res.status(201).json({
    blueprint: bp,
    readiness: validators.readyToGenerate(bp),
    presets: presetIds().map(presetSummary),
  });
});

const getBlueprint = asyncHandler(async (req, res) => {
  const bp = await mineBlueprint(req, req.params.id);
  res.json({ blueprint: bp, readiness: validators.readyToGenerate(bp), presets: presetIds().map(presetSummary) });
});

const updateBlueprint = asyncHandler(async (req, res) => {
  const bp = await mineBlueprint(req, req.params.id);
  const expected = Number(req.body.revision);
  if (!Number.isSafeInteger(expected)) throw httpError(400, "revision_required", "`revision` göndərilməlidir.");

  const patch = {};
  for (const f of ["title", "grade", "subject", "standard", "textbookEdition"]) {
    if (req.body[f] !== undefined) patch[f] = String(req.body[f]).slice(0, 300);
  }
  if (req.body.subStandards !== undefined) patch.subStandards = (req.body.subStandards || []).map(String);
  if (req.body.totalPoints !== undefined) patch.totalPoints = Number(req.body.totalPoints);
  if (Array.isArray(req.body.rows)) {
    // Bloom is stored PER ROW so any structure is expressible. readyToGenerate
    // still demands a recognised level on every row, so a blank or invented level
    // blocks generation instead of reaching the paper.
    patch.rows = req.body.rows.map((r) => ({ ...r, no: Number(r.no) }));
    patch.rowCount = patch.rows.length;
  }
  const updated = await MsoBlueprint.findOneAndUpdate(
    { _id: bp._id, owner: req.user._id, revision: expected === 0 ? { $in: [0, null] } : expected },
    { $set: patch, $inc: { revision: 1 } },
    { new: true }
  );
  if (!updated) throw httpError(409, "mso_conflict", "Blueprint başqa yerdə dəyişdirilib — səhifəni yeniləyin.");
  res.json({ blueprint: updated, readiness: validators.readyToGenerate(updated) });
});

/*
 * POST /:id/generate — the owner-decision gate.
 *
 * Reached only when the operation is priced (requireActiveOperation runs first).
 * Even then it refuses with 422 while the blueprint is incomplete.
 */
const generateMso = asyncHandler(async (req, res) => {
  const bp = await mineBlueprint(req, req.params.id);
  const readiness = validators.readyToGenerate(bp);
  if (!readiness.ok) {
    throw httpError(
      422,
      "blueprint_incomplete",
      `Blueprint tamamlanmayıb: ${readiness.undecidedRows.length ? `${readiness.undecidedRows.join(", ")} nömrəli sualların tipi/balı təyin edilməyib.` : "sahələr çatışmır."}`,
      { reason: "blueprint_incomplete", undecidedRows: readiness.undecidedRows, problems: readiness.problems }
    );
  }
  const { startJob } = require("../services/msoJobService");
  const job = await startJob({
    owner: req.user._id,
    blueprintId: bp._id,
    clientReqId: String(req.body.clientReqId || ""),
    sourceVersions: bp.sourceVersions || [],
  });
  res.status(202).json({ job: { _id: job._id, state: job.state, batches: (job.batches || []).length } });
});

const getDocument = asyncHandler(async (req, res) => {
  const doc = await MsoDocument.findById(req.params.id);
  if (!doc) throw httpError(404, "document_missing", "Sənəd tapılmadı.");
  if (!(String(doc.owner) === String(req.user._id) || req.user.role === "admin")) {
    throw httpError(403, "not_owner", "Bu sənəd sizə aid deyil.");
  }
  const bp = await MsoBlueprint.findById(doc.blueprint).lean();
  const check = validators.validateMsoDocument(doc.toObject(), bp);
  res.json({
    document: doc,
    validation: check,
    // Derived from the SAME tasks as the paper, so it cannot contradict it.
    analytics: validators.buildAnalyticsTable(doc.toObject(), bp),
  });
});

// Teacher review of one task: accept, reject, or mark for review.
const reviewTask = asyncHandler(async (req, res) => {
  const doc = await MsoDocument.findById(req.params.id);
  if (!doc) throw httpError(404, "document_missing", "Sənəd tapılmadı.");
  if (String(doc.owner) !== String(req.user._id)) throw httpError(403, "not_owner", "Bu sənəd sizə aid deyil.");
  const { no, variant, reviewStatus, verifyStatus } = req.body || {};
  const task = (doc.tasks || []).find((t) => Number(t.no) === Number(no) && t.variant === variant);
  if (!task) throw httpError(404, "task_missing", "Tapşırıq tapılmadı.");
  if (reviewStatus) task.reviewStatus = reviewStatus;
  // A teacher confirming a citation against the server-rendered crop is the
  // primary path for scanned sources, which can never be machine-matched.
  if (verifyStatus && task.sourceEvidence) task.sourceEvidence.verifyStatus = verifyStatus;
  await doc.save();
  res.json({ task });
});

const publishMso = asyncHandler(async (req, res) => {
  const doc = await MsoDocument.findById(req.params.id);
  if (!doc) throw httpError(404, "document_missing", "Sənəd tapılmadı.");
  if (String(doc.owner) !== String(req.user._id)) throw httpError(403, "not_owner", "Bu sənəd sizə aid deyil.");
  const bp = await MsoBlueprint.findById(doc.blueprint).lean();

  // strict: every task accepted, every textbook_only citation resolved.
  const check = validators.validateMsoDocument(doc.toObject(), bp, { strict: true });
  if (!check.ok) {
    throw httpError(422, "mso_invalid", "Sənəd dərc üçün hazır deyil.", { problems: check.problems.slice(0, 40) });
  }

  const versions = await CurriculumSourceVersion.find({ _id: { $in: doc.sourceVersions || [] } }).select("sha256").lean();
  const version = await publishWithRetry(withMongoTransaction, {
    Parent: MsoDocument,
    Version: MsoVersion,
    docId: doc._id,
    content: {
      title: doc.title,
      tasks: doc.toObject().tasks,
      blueprint: bp,
      analytics: validators.buildAnalyticsTable(doc.toObject(), bp),
      showCitationsToStudents: doc.showCitationsToStudents,
    },
    author: req.user._id,
    extra: { sourceVersions: doc.sourceVersions || [], sourceHashes: versions.map((v) => v.sha256) },
    onClaimSources: async (v, session) => {
      for (const svId of doc.sourceVersions || []) {
        await transferHolder(
          { sourceVersionId: svId, fromKind: "draft", fromId: doc._id, toKind: "published_version", toId: v._id, holderLabel: doc.title },
          session
        ).catch(async (e) => {
          if (e && e.code === "source_hold_missing") {
            await claimNew({ sourceVersionId: svId, holderKind: "published_version", holderId: v._id, holderLabel: doc.title }, session);
            return;
          }
          throw e;
        });
      }
    },
  });
  res.json({ version: { _id: version._id, versionNumber: version.versionNumber, contentHash: version.contentHash } });
});

/*
 * Four RENDERINGS of one frozen version: student paper, teacher paper, answer key
 * and analytics. None is a second AI call, so none can contradict another.
 */
const renderMso = asyncHandler(async (req, res) => {
  const doc = await MsoDocument.findById(req.params.id).lean();
  if (!doc) throw httpError(404, "document_missing", "Sənəd tapılmadı.");
  if (String(doc.owner) !== String(req.user._id) && req.user.role !== "admin") {
    throw httpError(403, "not_owner", "Bu sənəd sizə aid deyil.");
  }
  if (!doc.activeVersion) throw httpError(409, "not_published", "Əvvəlcə sənədi dərc edin.");
  const version = await MsoVersion.findById(doc.activeVersion).lean();
  const variant = req.query.variant === "B" ? "B" : "A";
  const tasks = (version.content.tasks || []).filter((t) => t.variant === variant);
  const view = String(req.query.view || "student");

  if (view === "student") {
    return res.json({
      variant,
      versionNumber: version.versionNumber,
      tasks: tasks.map((t) => ({
        no: t.no,
        points: t.points,
        statement: t.statement,
        choices: t.choices,
        // Answers, solutions, rubrics, Bloom and citations are teacher
        // documentation and never travel to a student paper.
        ...(version.content.showCitationsToStudents && t.sourceEvidence
          ? { citation: { page: t.sourceEvidence.printedPageLabel, no: t.sourceEvidence.sourceTaskNo } }
          : {}),
      })),
    });
  }
  if (view === "key") {
    return res.json({
      variant,
      versionNumber: version.versionNumber,
      key: tasks.map((t) => ({ no: t.no, correctIndex: t.correctIndex, answer: t.answer, points: t.points })),
      pointsTotal: tasks.reduce((s, t) => s + (Number(t.points) || 0), 0),
    });
  }
  if (view === "analytics") {
    return res.json({ versionNumber: version.versionNumber, analytics: version.content.analytics });
  }
  return res.json({ variant, versionNumber: version.versionNumber, tasks });
});

module.exports = {
  listPresets,
  listBlueprints,
  createBlueprint,
  getBlueprint,
  updateBlueprint,
  generateMso,
  getDocument,
  reviewTask,
  publishMso,
  renderMso,
};
