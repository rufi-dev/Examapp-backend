const asyncHandler = require("express-async-handler");
const LessonDoc = require("../models/lessonDocModel");
const { httpError } = require("../utils/appError");
const S = require("../helper/lessonDocSchema");
const { buildLessonDocHtml } = require("../helper/lessonDocHtml");

/*
 * Lesson materials, written through a conversation.
 *
 * The chat is not a general assistant — every turn acts on ONE document. That is
 * what makes "add two more examples" mean something, and it is why the whole
 * current document is sent with each edit rather than a transcript: the model needs
 * the artefact, not the history of how it got there.
 */

const MAX_DOCS = 200;

const mine = async (req, id) => {
  const doc = await LessonDoc.findById(id);
  if (!doc) throw httpError(404, "doc_missing", "Material tapılmadı.");
  const admin = req.user?.role === "admin";
  if (!admin && String(doc.owner) !== String(req.user._id)) {
    throw httpError(403, "not_owner", "Bu material sizə aid deyil.");
  }
  return doc;
};

// GET /
const listDocs = asyncHandler(async (req, res) => {
  const docs = await LessonDoc.aggregate([
    { $match: { owner: req.user._id, archivedAt: null } },
    { $sort: { updatedAt: -1 } },
    {
      $project: {
        title: 1, topic: 1, subject: 1, grade: 1, format: 1, status: 1, updatedAt: 1,
        // The card needs a shape, not the document: sending every block to draw
        // "12 blok" would be hundreds of kilobytes per row.
        blockCount: { $size: { $ifNull: ["$blocks", []] } },
        taskCount: {
          $size: {
            $filter: { input: { $ifNull: ["$blocks", []] }, as: "b", cond: { $eq: ["$$b.kind", "task"] } },
          },
        },
        exampleCount: {
          $size: {
            $filter: { input: { $ifNull: ["$blocks", []] }, as: "b", cond: { $eq: ["$$b.kind", "example"] } },
          },
        },
        turns: { $size: { $ifNull: ["$messages", []] } },
      },
    },
  ]);
  res.json({ docs });
});

// POST /
const createDoc = asyncHandler(async (req, res) => {
  const owned = await LessonDoc.countDocuments({ owner: req.user._id, archivedAt: null });
  if (owned >= MAX_DOCS) {
    throw httpError(422, "too_many_docs", `Ən çox ${MAX_DOCS} material saxlaya bilərsiniz.`);
  }
  const b = req.body || {};
  const doc = await LessonDoc.create({
    owner: req.user._id,
    topic: String(b.topic || "").trim(),
    title: String(b.title || b.topic || "").trim(),
    subject: String(b.subject || "").trim(),
    grade: String(b.grade || "").trim(),
    audience: String(b.audience || "").trim(),
    format: b.format === "docx" ? "docx" : "pdf",
  });
  res.status(201).json({ doc });
});

// GET /:id
const getDoc = asyncHandler(async (req, res) => {
  res.json({ doc: await mine(req, req.params.id) });
});

/*
 * POST /:id/message — one turn.
 *
 * The FIRST turn writes the document; every turn after edits it. Both go through
 * the same schema, so a material is the same shape however far into the
 * conversation it was written.
 *
 * The teacher's message is stored BEFORE the model runs. A provider timeout must
 * not lose what they typed — they should reopen the page and see their own words
 * still there, with a failure beside them.
 */
const sendMessage = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) throw httpError(400, "message_empty", "Nə yaratmaq istədiyinizi yazın.");
  if (text.length > 4000) throw httpError(422, "message_long", "Mesaj çox uzundur.");

  doc.messages = [...(doc.messages || []), { role: "user", text, at: new Date() }];
  await doc.save();

  const { runDocument } = require("../helper/aiDocument");
  const { toGeminiSchema } = require("../helper/curriculumSchema");

  const hadBlocks = (doc.blocks || []).length > 0;
  const { system, prompt } = hadBlocks
    ? S.buildEditPrompt({ doc: doc.toObject(), instructions: text })
    : S.buildCreatePrompt({ doc: doc.toObject(), instructions: text });

  let out;
  try {
    out = await runDocument({
      system,
      prompt,
      parts: [],
      schema: S.DOC_SCHEMA,
      geminiSchema: toGeminiSchema(S.DOC_SCHEMA),
      maxTokens: 8000,
    });
  } catch (e) {
    doc.messages = [
      ...(doc.messages || []),
      { role: "assistant", text: e?.userMessage || "Alınmadı — bir az sonra yenidən cəhd edin.", action: "failed", at: new Date() },
    ];
    await doc.save();
    res.status(e?.aiStatus || 502);
    throw new Error(e?.userMessage || "Material hazırlanmadı.");
  }

  const keepIds = (doc.blocks || []).map((b) => b.id);
  const next = S.normalizeDoc(out.doc || {}, { keepIds });

  if (!next.blocks.length) {
    doc.messages = [
      ...(doc.messages || []),
      { role: "assistant", text: "Məzmun qaytarılmadı — istəyinizi bir az dəqiqləşdirin.", action: "failed", at: new Date() },
    ];
    await doc.save();
    throw httpError(502, "empty_doc", "Material boş qayıtdı — istəyinizi dəqiqləşdirin.");
  }

  const sum = S.summarize(next.blocks);
  doc.blocks = next.blocks;
  if (next.title) doc.title = next.title;
  if (!doc.topic) doc.topic = next.title;
  doc.status = "ready";
  doc.revision = (doc.revision || 0) + 1;
  doc.aiMeta = { provider: out.provider, at: new Date() };
  /*
   * The model's own words, with the counts kept separately as a receipt beside
   * them. A teacher who asks for something subtle — "simpler for weaker students" —
   * cannot tell from "12 blok" whether it was understood.
   */
  doc.messages = [
    ...(doc.messages || []),
    {
      role: "assistant",
      text:
        next.reply ||
        (hadBlocks
          ? "Dəyişdirildi."
          : "Material hazırdır."),
      action: hadBlocks ? "edited" : "created",
      stats: sum,
      at: new Date(),
    },
  ];
  await doc.save();

  res.json({ doc, summary: sum, provider: out.provider });
});

/*
 * PATCH /:id — the teacher's own edit.
 *
 * Free, exact and never routed through the model: fixing a typo should not cost a
 * credit or risk the rest of the document being rewritten. Guarded by the same
 * revision CAS as lesson plans so two tabs cannot silently overwrite each other.
 */
const updateDoc = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const b = req.body || {};

  if (b.revision !== undefined && Number(b.revision) !== doc.revision) {
    throw httpError(409, "doc_conflict", "Material başqa yerdə dəyişdirilib — səhifəni yeniləyin.");
  }

  for (const f of ["title", "topic", "subject", "grade", "audience"]) {
    if (b[f] !== undefined) doc[f] = String(b[f] || "").trim();
  }
  if (b.format !== undefined) doc.format = b.format === "docx" ? "docx" : "pdf";

  if (Array.isArray(b.blocks)) {
    // Run the teacher's blocks through the SAME normaliser as the model's, so a
    // hand-edited document cannot end up in a shape the renderer has never seen.
    const kept = S.normalizeDoc({ title: doc.title, blocks: b.blocks }, { keepIds: b.blocks.map((x) => x && x.id) });
    doc.blocks = kept.blocks;
  }

  doc.revision = (doc.revision || 0) + 1;
  await doc.save();
  res.json({ doc });
});

// DELETE /:id
const removeDoc = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  await LessonDoc.deleteOne({ _id: doc._id });
  res.json({ ok: true });
});

/*
 * GET /:id/export?format=pdf|docx
 *
 * Both come from the same content walk, so the Word file and the PDF can never
 * describe different lessons.
 */
const exportDoc = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  if (!(doc.blocks || []).length) {
    throw httpError(422, "doc_empty", "Materialda məzmun yoxdur.");
  }

  const wanted = String(req.query.format || doc.format || "pdf").toLowerCase();
  const format = wanted === "docx" ? "docx" : "pdf";
  const plain = doc.toObject();
  const { safeName } = require("../helper/lessonDocDocx");

  let body;
  let mime;
  if (format === "docx") {
    const { htmlToDocx } = require("../helper/lessonDocDocx");
    body = await htmlToDocx(buildLessonDocHtml(plain, { forWord: true }));
    mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  } else {
    const { renderPdf } = require("./../helper/lessonPlanPdf");
    body = await renderPdf(buildLessonDocHtml(plain), { footerLabel: "dərs materialı" });
    mime = "application/pdf";
  }

  const name = safeName(doc.title || doc.topic, format);
  res.setHeader("Content-Type", mime);
  // A Word file is downloaded, never previewed — the browser has nothing to show.
  res.setHeader(
    "Content-Disposition",
    `${format === "docx" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.send(body);
});

module.exports = { listDocs, createDoc, getDoc, sendMessage, updateDoc, removeDoc, exportDoc };
