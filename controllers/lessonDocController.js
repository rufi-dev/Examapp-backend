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

  // Stamp the references that are going up with this turn, so the transcript can
  // show the teacher what the model was actually given rather than leaving them to
  // wonder whether the PDF made it.
  const sent = (doc.files || []).map((f) => ({ key: f.key, name: f.name, mime: f.mime }));
  doc.messages = [
    ...(doc.messages || []),
    { role: "user", text, at: new Date(), ...(sent.length ? { files: sent } : {}) },
  ];
  await doc.save();

  const { runDocument } = require("../helper/aiDocument");
  const { toGeminiSchema } = require("../helper/curriculumSchema");

  const hadBlocks = (doc.blocks || []).length > 0;
  // The references go with EVERY turn, not just the first.
  const parts = await require("../helper/lessonDocFiles").toParts(doc.files || []);
  const { system, prompt } = hadBlocks
    ? S.buildEditPrompt({ doc: doc.toObject(), instructions: text })
    : S.buildCreatePrompt({ doc: doc.toObject(), instructions: text });

  let out;
  try {
    out = await runDocument({
      system,
      prompt,
      parts,
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
 * POST /:id/message/stream — the same turn, reported as it happens.
 *
 * TWO REAL PHASES, and both are the model's own work rather than an animation:
 *
 *   1. PLAN. A small, fast call reads the teacher's request and commits to a shape:
 *      the title, who it is for, and the sections it will write with a reason for
 *      each. It is emitted the moment it lands, so within a couple of seconds the
 *      teacher can see what was understood — and say so if it is wrong — instead of
 *      staring at a spinner for forty.
 *
 *   2. WRITE. The document call, streamed. Each block is emitted AS IT CLOSES in
 *      the response, so the progress is the number of blocks actually written. Not
 *      a timer, not a guess.
 *
 * Streaming is Claude's today. On a fallback provider no block events arrive and the
 * client shows the plan with an indeterminate wait — which is the truth about that
 * request rather than motion invented to cover it.
 */
const streamMessage = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) throw httpError(400, "message_empty", "Nə yaratmaq istədiyinizi yazın.");
  if (text.length > 4000) throw httpError(422, "message_long", "Mesaj çox uzundur.");

  // Stamp the references that are going up with this turn, so the transcript can
  // show the teacher what the model was actually given rather than leaving them to
  // wonder whether the PDF made it.
  const sent = (doc.files || []).map((f) => ({ key: f.key, name: f.name, mime: f.mime }));
  doc.messages = [
    ...(doc.messages || []),
    { role: "user", text, at: new Date(), ...(sent.length ? { files: sent } : {}) },
  ];
  await doc.save();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Caddy buffers by default, which would hold every event until the end and
    // turn a live report into one silent wait followed by everything at once.
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };
  res.write(": ok\n\n");
  // Mobile networks and proxies drop an idle connection; the plan call alone can
  // take longer than some of them tolerate.
  const hb = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 7000);

  const { runDocument } = require("../helper/aiDocument");
  const { toGeminiSchema } = require("../helper/curriculumSchema");
  const hadBlocks = (doc.blocks || []).length > 0;
  // Attached references travel with every turn, and with the PLAN too — deciding
  // what to write from a page the model cannot see is deciding blind.
  const parts = await require("../helper/lessonDocFiles").toParts(doc.files || []);

  try {
    /*
     * ---- phase 1: what are we about to do? ---------------------------------
     *
     * Runs for an EDIT as well as a creation. It used to be creation-only, which
     * left every change showing nothing but "Dəyişirəm…" for the length of a long
     * call — a spinner with a word on it. Now both paths answer the question the
     * teacher is actually asking while they wait: what did you understand, and
     * what are you about to do to my document.
     */
    let plan = null;
    send("phase", { phase: "plan", editing: hadBlocks });
    try {
      const p = await runDocument({
        ...S.buildPlanPrompt({ doc: doc.toObject(), instructions: text, editing: hadBlocks }),
        parts,
        schema: S.PLAN_SCHEMA,
        geminiSchema: toGeminiSchema(S.PLAN_SCHEMA),
        maxTokens: 1200,
      });
      plan = S.normalizePlan(p.doc || {});
      if (plan.sections.length) send("plan", { ...plan, editing: hadBlocks });
    } catch {
      // A failed plan is not a failed turn — the writing pass can still run, it
      // just runs without a preview.
      plan = null;
    }

    // ---- phase 2: write it, reporting each block -----------------------------
    send("phase", { phase: "write", sections: plan?.sections?.length || 0 });

    const base = hadBlocks
      ? S.buildEditPrompt({ doc: doc.toObject(), instructions: text })
      : S.buildCreatePrompt({ doc: doc.toObject(), instructions: text });
    if (parts.length) {
      base.system = `${base.system}

${S.SOURCE_RULES}`;
    }

    /*
     * Hold the writing pass to what it just committed to — but the two plans mean
     * different things and must not be handed over with the same sentence.
     *
     * On a creation the plan IS the document's outline, so "the sections must be
     * exactly these" is right. On an edit the same list is a set of OPERATIONS
     * ("add three examples", "draw a figure"); telling the writer those are the
     * document's sections would have it replace a 26-block handout with four
     * blocks named after the work. Same data, opposite instruction.
     */
    const planLines = plan?.sections?.length
      ? plan.sections.map((sx, i) => `${i + 1}. ${sx.heading} — ${sx.why}`).join("\n")
      : "";
    const prompt = !planLines
      ? base.prompt
      : hadBlocks
        ? `${base.prompt}\n\nRAZILAŞDIRILMIŞ ADDIMLAR — yalnız bunları et, başqa heç nəyi dəyişmə:\n${planLines}`
        : `${base.prompt}\n\nRAZILAŞDIRILMIŞ PLAN — bölmələr məhz bunlar olmalıdır:\n${planLines}`;

    const readBlocks = S.makeBlockStreamer();
    let seen = 0;
    const out = await runDocument({
      system: base.system,
      prompt,
      parts,
      schema: S.DOC_SCHEMA,
      geminiSchema: toGeminiSchema(S.DOC_SCHEMA),
      maxTokens: 8000,
      onText: (snapshot) => {
        for (const b of readBlocks(snapshot)) {
          seen += 1;
          // The block itself, so the client can name what just landed rather than
          // counting anonymously.
          send("block", { n: seen, kind: String(b.kind || ""), text: String(b.text || b.term || "").slice(0, 90) });
        }
      },
    });

    const keepIds = (doc.blocks || []).map((b) => b.id);
    const next = S.normalizeDoc(out.doc || {}, { keepIds });
    if (!next.blocks.length) {
      doc.messages = [
        ...(doc.messages || []),
        { role: "assistant", text: "Məzmun qaytarılmadı — istəyinizi bir az dəqiqləşdirin.", action: "failed", at: new Date() },
      ];
      await doc.save();
      send("failed", { message: "Material boş qayıtdı — istəyinizi dəqiqləşdirin." });
      return;
    }

    const sum = S.summarize(next.blocks);
    doc.blocks = next.blocks;
    if (next.title) doc.title = next.title;
    if (!doc.topic) doc.topic = next.title;
    if (plan?.audience && !doc.audience) doc.audience = plan.audience;
    doc.status = "ready";
    doc.revision = (doc.revision || 0) + 1;
    doc.aiMeta = { provider: out.provider, at: new Date() };
    doc.messages = [
      ...(doc.messages || []),
      {
        role: "assistant",
        text: next.reply || (hadBlocks ? "Dəyişdirildi." : "Material hazırdır."),
        action: hadBlocks ? "edited" : "created",
        stats: sum,
        at: new Date(),
      },
    ];
    await doc.save();

    send("done", { doc, summary: sum, provider: out.provider });
  } catch (e) {
    doc.messages = [
      ...(doc.messages || []),
      { role: "assistant", text: e?.userMessage || "Alınmadı — bir az sonra yenidən cəhd edin.", action: "failed", at: new Date() },
    ];
    await doc.save().catch(() => {});
    send("failed", { message: e?.userMessage || e?.message || "Material hazırlanmadı." });
  } finally {
    clearInterval(hb);
    res.end();
  }
});


/*
 * POST /:id/files — attach a reference.
 *
 * Accepted types are exactly what the providers can actually read. A .docx would be
 * silently ignored by all of them, so it is refused with a reason rather than
 * accepted and quietly dropped at the point it was supposed to help.
 */
const addFile = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const F = require("../helper/lessonDocFiles");
  const f = req.file;
  if (!f) throw httpError(400, "no_file", "Fayl seçilmədi.");
  if (!F.ACCEPT[f.mimetype]) {
    throw httpError(415, "bad_type", "Yalnız PDF və şəkil (PNG, JPG, WEBP) əlavə etmək olar.");
  }

  const files = doc.files || [];
  if (files.length >= F.MAX_FILES) {
    throw httpError(422, "too_many_files", `Ən çox ${F.MAX_FILES} fayl əlavə edə bilərsiniz.`);
  }
  const total = files.reduce((n, x) => n + (x.bytes || 0), 0) + f.size;
  if (total > F.MAX_TOTAL_MB * 1024 * 1024) {
    throw httpError(413, "too_large", `Faylların ümumi həcmi ${F.MAX_TOTAL_MB}MB-dan çox ola bilməz.`);
  }

  const saved = await F.saveFile({ buffer: f.buffer, mime: f.mimetype, name: f.originalname });
  // The same page attached twice is one entry, not two identical ones in the list.
  if (!files.some((x) => x.key === saved.key)) {
    doc.files = [...files, saved];
    await doc.save();
  }
  res.status(201).json({ doc });
});

/*
 * GET /:id/files/:key — serve an attachment back.
 *
 * So a thumbnail survives a reload: an object URL made at upload time dies with the
 * page, and a teacher who reopens a material would find their references reduced to
 * filenames. Owner-scoped and no-store — these are someone's textbook pages.
 */
const getFile = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const F = require("../helper/lessonDocFiles");
  const f = (doc.files || []).find((x) => x.key === String(req.params.key || ""));
  if (!f) throw httpError(404, "file_missing", "Fayl tapılmadı.");

  const fsp = require("fs/promises");
  let buf;
  try {
    buf = await fsp.readFile(F.pathForKey(f.key, f.ext));
  } catch {
    throw httpError(404, "file_missing", "Fayl serverdə tapılmadı.");
  }
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name || "fayl")}`);
  res.send(buf);
});

// DELETE /:id/files/:key
const removeFile = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const F = require("../helper/lessonDocFiles");
  const key = String(req.params.key || "");
  const gone = (doc.files || []).find((x) => x.key === key);
  if (!gone) throw httpError(404, "file_missing", "Fayl tapılmadı.");

  doc.files = (doc.files || []).filter((x) => x.key !== key);
  await doc.save();

  // Content-addressed, so another material may hold the identical file.
  const stillUsed = await LessonDoc.exists({ _id: { $ne: doc._id }, "files.key": key });
  await F.removeIfUnused(key, gone.ext, Boolean(stillUsed));
  res.json({ doc });
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
  const { withRasterFigures } = require("../helper/lessonDocHtml");

  let body;
  let mime;
  if (format === "docx") {
    const { htmlToDocx } = require("../helper/lessonDocDocx");
    // Figures become PNGs first; LibreOffice cannot be trusted with inline SVG.
    body = await htmlToDocx(buildLessonDocHtml(await withRasterFigures(plain), { forWord: true }));
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

module.exports = { listDocs, createDoc, getDoc, sendMessage, streamMessage, addFile, getFile, removeFile, updateDoc, removeDoc, exportDoc };
