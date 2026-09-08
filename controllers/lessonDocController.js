const asyncHandler = require("express-async-handler");
const LessonDoc = require("../models/lessonDocModel");
const { httpError, isAppError } = require("../utils/appError");
const S = require("../helper/lessonDocSchema");
const { checkTables, gridMap } = require("../helper/lessonDocTables");
const { buildLessonDocHtml } = require("../helper/lessonDocHtml");
// Every write to a document goes through here. No path in this file may call
// doc.save() — see the header of services/lessonDocService.js for why.
const svc = require("../services/lessonDocService");
const { sanitizeDocHtml, droppedStyles } = require("../helper/lessonDocSanitize");

/*
 * Lesson materials, written through a conversation.
 *
 * The chat is not a general assistant — every turn acts on ONE document. That is
 * what makes "add two more examples" mean something, and it is why the whole
 * current document is sent with each edit rather than a transcript: the model needs
 * the artefact, not the history of how it got there.
 */

const MAX_DOCS = 200;

/*
 * One opaque answer for "not yours" and "not there".
 *
 * A 403 on someone else's document and a 404 on a missing one are different
 * answers to the same probe, and the difference IS the leak: it confirms that a
 * given id exists and belongs to somebody. A teacher can only ever act on their
 * own materials, so the distinction buys them nothing and costs privacy.
 *
 * An admin still gets the truthful answer — they are allowed to know.
 * A malformed id takes the same path rather than throwing a CastError, which
 * used to surface as a 500 on a mistyped URL.
 */
const missing = () => httpError(404, "doc_missing", "Material tapılmadı.");

const mine = async (req, id) => {
  const admin = req.user?.role === "admin";
  let doc = null;
  try {
    doc = await LessonDoc.findById(id);
  } catch {
    throw missing();
  }
  if (!doc) throw missing();
  if (!admin && String(doc.owner) !== String(req.user._id)) {
    throw admin ? httpError(403, "not_owner", "Bu material sizə aid deyil.") : missing();
  }
  return doc;
};

/*
 * The only error text allowed onto the wire from a streamed turn.
 *
 * The SSE failure path used to send `e?.userMessage || e?.message`. That second
 * fallback is a raw-egress channel with nothing in front of it: a Mongo error, a
 * TypeError, a provider body — whatever the exception happened to carry went
 * straight into the teacher's toast. It cannot be caught by errorMiddleware
 * either, because by then the 200 and the headers are long gone.
 *
 * So: a curated message, chosen from a fixed vocabulary, or a generic one. An
 * AppError and a docError both carry text written FOR a teacher, so those pass
 * through; anything else is reported generically and logged in full server-side,
 * where it belongs.
 */
const PUBLIC_FAILURE = {
  provider_unavailable: "AI xidməti cavab vermir — bir az sonra yenidən cəhd edin.",
  generation_timeout: "Cavab çox uzun çəkdi — yenidən cəhd edin.",
  validation_failed: "Material gözlənilən formatda qayıtmadı — istəyinizi dəqiqləşdirin.",
  document_conflict: "Material başqa yerdə dəyişdirilib — səhifəni yeniləyin.",
  storage_unavailable: "Fayl saxlanmadı — bir az sonra yenidən cəhd edin.",
  export_failed: "Fayl hazırlanmadı — bir az sonra yenidən cəhd edin.",
  operation_cancelled: "Dayandırıldı.",
  source_unreadable: "Əlavə edilmiş fayl oxunmadı.",
  generation_failed: "Material hazırlanmadı — bir az sonra yenidən cəhd edin.",
  // Not a bad minute: waiting will not fix an unpaid account, and saying it will
  // sends a teacher into a retry loop against something only the owner can act on.
  service_suspended: "AI xidməti dayandırılıb — administratorla əlaqə saxlayın.",
};

/*
 * What a turn cost, recorded where the admin AI-cost page already looks.
 *
 * Studio has no rate limit, no daily budget guard and no credit charge — by
 * decision. That makes this row the ONLY way anyone can see what the feature
 * spends: without it, the one AI surface with no ceiling is also the one with no
 * meter, and the first sign of a runaway would be the invoice.
 *
 * Never throws. A usage row failing to write must not cost the teacher the
 * material they just waited for.
 */
const logStudioUsage = async (req, { doc, out, hadBlocks }) => {
  try {
    const AiUsage = require("../models/aiUsageModel");
    const c = (out && out.cost) || {};
    await AiUsage.create({
      user: req.user._id,
      operation: hadBlocks ? "ai.edit.material" : "ai.generate.material",
      model: c.model || (out && out.provider) || "unknown",
      inputTokens: c.inputTokens || 0,
      outputTokens: c.outputTokens || 0,
      cacheWriteTokens: c.cacheWriteTokens || 0,
      cacheReadTokens: c.cacheReadTokens || 0,
      totalTokens: c.totalTokens || 0,
      usd: c.usd || 0,
      blocks: S.countParts(doc),
    });
  } catch (e) {
    console.error("[LESSON DOC] usage log failed:", e?.message);
  }
};

/*
 * One place where an AI turn becomes the document.
 *
 * Both turn paths — the plain POST and the streamed one — used to hand-assemble
 * the same seven field writes and then call `doc.save()`, which is how they drifted
 * apart in the first place. They now agree by construction, and both commit
 * against the revision the turn STARTED from, so a generation that finishes after
 * a manual edit loses instead of erasing it.
 *
 * The assistant's message rides along in the same write. It is part of the turn,
 * not a separate event: a document that gained twelve blocks with no message
 * saying why would be exactly the kind of half-applied state this is here to
 * prevent.
 */
async function commitTurn(doc, baseRevision, { next, out, hadBlocks, sum, reply, note = "", action, audience, plan }) {
  const message = {
    role: "assistant",
    text: note ? `${reply} ${note}` : reply,
    action: action || (hadBlocks ? "edited" : "created"),
    stats: sum,
    // The work log, kept with the message it produced, so a teacher can reopen
    // "what did it read, what did it decide" long after the turn scrolled away.
    ...(plan && (plan.sources?.length || plan.sections?.length)
      ? { work: { sources: plan.sources || [], steps: plan.sections || [] } }
      : {}),
    at: new Date(),
  };
  return svc.commit(
    doc._id,
    doc.owner,
    {
      blocks: next.blocks,
      ...(next.title ? { title: next.title } : {}),
      ...(!doc.topic && next.title ? { topic: next.title } : {}),
      ...(audience && !doc.audience ? { audience } : {}),
      status: "ready",
      aiMeta: { provider: (out && out.provider) || "unknown", at: new Date() },
    },
    baseRevision,
    // Pushed, not set: the teacher's own message was appended to this document
    // after `doc` was read, so writing the array back would delete it.
    { push: { messages: message } }
  );
}

/*
 * The receipt for an HTML document: what it actually contains.
 *
 * S.summarize counted blocks, which no longer exist for a document the model
 * wrote itself. Counting the rendered structure keeps the chips honest — a
 * teacher reading "12 nümunə" should be able to find twelve of them.
 */
function summarizeHtml(html) {
  const count = (re) => (String(html).match(re) || []).length;
  return {
    blocks: count(/<(h[1-4]|p|ul|ol|table|figure|blockquote)/gi),
    examples: count(/class="[^"]*ex/gi),
    tasks: count(/class="[^"]*task/gi),
  };
}

/*
 * The print options a tool call is allowed to set.
 *
 * Read off the call rather than spread from it: a tool input is model output, and
 * the one place it reaches document state is the one place to be exact about what
 * may pass. An accent outside the known palette is ignored rather than written —
 * each name carries a tint chosen to keep text on it readable, so an unknown one
 * has no colours to render with.
 */
const { ACCENTS } = require("../helper/lessonDocHtml");
function printOptions(input = {}) {
  const patch = { "settings.pageNumbers": input.pageNumbers !== false };
  if (typeof input.accent === "string" && ACCENTS[input.accent]) patch["settings.accent"] = input.accent;
  return patch;
}

/*
 * The files this turn is adding, not every file the document holds.
 *
 * Every turn sends ALL attachments to the model — that is what makes "add three
 * more like the ones on page 4" work five turns later — and the transcript used
 * to stamp each message with that same full list. So a teacher who attached one
 * PDF saw two cards on their message, then three, and reasonably read it as the
 * interface losing track of their files.
 *
 * A message shows what was attached FOR it. A file is "already sent" once some
 * earlier message carries it, which is the same rule the composer uses to decide
 * what is still staged, so the two can never disagree.
 */
function stagedFiles(doc) {
  /*
   * Asked of the FILE, not of the transcript.
   *
   * This used to mean "not mentioned in any message yet", which quietly made
   * attaching a one-way door: keys are content hashes, so re-uploading the same
   * page produced the same key, the key was already stamped on an older message,
   * and the file was treated as long since sent. The teacher watched their upload
   * succeed and no card appear. Whether these bytes are already on disk and
   * whether this file is part of THIS turn are different questions.
   */
  return (doc.files || [])
    .filter((f) => f.stagedAt)
    .map((f) => ({ key: f.key, name: f.name, mime: f.mime }));
}

/*
 * Fail closed when the sources are gone.
 *
 * Some readable and some not is a warning — the teacher gets the material and is
 * told what was missing. But a teacher who attached files and got NONE of them
 * read is in the one situation where continuing is worse than stopping: every
 * instruction in the prompt says "base this on the attached page", and the model
 * would cheerfully write from general knowledge in exactly that voice. Refusing
 * is the honest answer, and it is recoverable — re-attach and ask again.
 */
function assertSourcesReadable(sending, parts, unreadable) {
  // Counted over what this turn is actually sending. Against the document's whole
  // file list, a turn that attaches nothing would look like a turn whose every
  // source failed to read, and refuse to run at all.
  const attached = sending.length;
  if (attached > 0 && parts.length === 0) {
    throw httpError(
      422,
      "source_unreadable",
      unreadable.length === 1
        ? `"${unreadable[0]}" oxunmadı — faylı yenidən əlavə edin.`
        : "Əlavə edilmiş fayllar oxunmadı — onları yenidən əlavə edin."
    );
  }
}

function publicFailure(e) {
  // Log the real thing exactly once, where only we can read it.
  console.error("[LESSON DOC] turn failed:", e?.code || e?.aiStatus || "", e?.message);
  const code = typeof e?.code === "string" && PUBLIC_FAILURE[e.code] ? e.code : null;
  if (code) return { code, message: e.userMessage || e.message || PUBLIC_FAILURE[code] };
  // A docError/AppError carries a message written for a teacher; anything else
  // is an internal detail and gets the generic line.
  const curated = e?.userMessage || (isAppError(e) ? e.message : "");
  return { code: e?.code || "generation_failed", message: curated || PUBLIC_FAILURE.generation_failed };
}

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
        // An html document has no blocks; it carries its own part count.
        blockCount: { $ifNull: ["$partCount", { $size: { $ifNull: ["$blocks", []] } }] },
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
  const User = require("../models/userModel");
  // Claim the slot BEFORE creating: count-then-create let ten concurrent requests
  // all read the same number and all decide there was room.
  await svc.reserveDocSlot(User, req.user._id, MAX_DOCS);

  const b = req.body || {};
  try {
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
  } catch (e) {
    // The slot was claimed and nothing was made with it — hand it back, or the
    // teacher loses an allowance to an error they did not cause.
    await svc.releaseDocSlot(User, req.user._id);
    throw e;
  }
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

  // What this turn is ADDING, not everything the document holds — see stagedFiles.
  const sent = stagedFiles(doc);
  await svc.appendMessages(doc._id, doc.owner, {
    role: "user",
    text,
    at: new Date(),
    ...(sent.length ? { files: sent } : {}),
  });
  // This turn is carrying them now, so they are no longer waiting to be carried.
  // By key, so a file attached while this turn was starting stays for the next.
  await svc.clearStaged(doc._id, doc.owner, sent.map((f) => f.key));

  const { runDocument } = require("../helper/aiDocument");
  const { toGeminiSchema } = require("../helper/curriculumSchema");

  /*
   * Is there already a document, or is this the first turn?
   *
   * This asked whether there were BLOCKS, which an html document never has — so
   * every turn on one looked like a first turn. The model was handed the create
   * prompt, never saw the material it was meant to be changing, and rebuilt it
   * from the attached file: a teacher asking to remove blank rows got their
   * translation and their colour thrown away and the English original back.
   * Everything downstream rode on the same flag, so the turn was also logged as a
   * generation and recorded in the transcript as "created".
   */
  const hadBlocks = S.countParts(doc) > 0;
  /*
   * The revision this turn is answering. The commit at the end must still match
   * it: a generation takes tens of seconds, and if the teacher edited a block in
   * the meantime this turn is writing a document that no longer exists.
   */
  const baseRevision = doc.revision || 0;
  // The references go with EVERY turn, not just the first.
  /*
   * What this turn ATTACHED, not everything the document has ever held.
   *
   * Files stay on the document, and every one of them was re-encoded and resent on
   * every turn afterwards. A teacher who attached a textbook page in turn one and
   * typed "make it shorter" in turn nine paid to upload that page nine times —
   * and, worse than the cost, the model kept being handed a source together with
   * instructions about sources on a turn that was about the document.
   *
   * The bytes are needed once. What has to persist is the KNOWLEDGE that the file
   * was sent and what came of it, and that lives in the transcript now: the
   * history names each attachment on the turn it arrived, so "the file I sent
   * earlier" stays answerable without shipping it again.
   */
  /*
   * Until a source has actually BEEN read, it keeps being sent.
   *
   * "Only this turn's attachments" was right about cost and wrong about a first
   * draft. A teacher attached ÇEVRƏ.pdf with "copy exactly as is"; the model
   * answered that turn by calling set_print_options, so nothing was written and
   * nothing was read — and from the next turn on the file was no longer sent,
   * because it was no longer newly attached. The model then wrote about the
   * document's TITLE, which was the only subject it had, and the teacher watched
   * their circles PDF turn into a lesson on inequalities.
   *
   * `sourceNotes` is the record of having read something. While it is empty, no
   * turn has ever seen inside these files, so no turn can be expected to know
   * them: they travel. Once one has, the notes carry the knowledge and
   * read_source fetches the page itself when the work needs the page. Bounded by
   * a fact about the document rather than by a guess about the request.
   */
  const neverRead = !(doc.sourceNotes || []).length;
  const sending = (doc.files || []).filter(
    (f) => neverRead || sent.some((x) => x.key === f.key)
  );
  const { parts, unreadable } = await require("../helper/lessonDocFiles").toParts(sending);
  assertSourcesReadable(sending, parts, unreadable);
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
      // No override — inherit aiDocument's own ceiling. A full-document rewrite
      // grows with the document; the fixed 8000 here used to truncate long edits.
    });
  } catch (e) {
    const pub = publicFailure(e);
    await svc.appendMessages(doc._id, doc.owner, {
      role: "assistant",
      text: pub.message,
      action: "failed",
      at: new Date(),
    });
    // An AppError so the curated message survives errorMiddleware, which replaces
    // the text of any non-AppError at 5xx with "Internal server error".
    throw httpError(e?.aiStatus === 422 ? 422 : 502, pub.code, pub.message);
  }

  const keepIds = (doc.blocks || []).map((b) => b.id);
  const next = S.normalizeDoc(out.doc || {}, { keepIds });

  if (!next.blocks.length) {
    await svc.appendMessages(doc._id, doc.owner, {
      role: "assistant",
      text: "Məzmun qaytarılmadı — istəyinizi bir az dəqiqləşdirin.",
      action: "failed",
      at: new Date(),
    });
    throw httpError(502, "empty_doc", "Material boş qayıtdı — istəyinizi dəqiqləşdirin.");
  }

  const sum = S.summarize(next.blocks);
  /*
   * The commit, against the revision this turn started from. If the teacher edited
   * a block while the model was writing, this loses with a 409 rather than
   * overwriting them — the whole point of taking `baseRevision` at the top.
   */
  const saved = await commitTurn(doc, baseRevision, {
    next,
    out,
    hadBlocks,
    sum,
    reply: next.reply || (hadBlocks ? "Dəyişdirildi." : "Material hazırdır."),
  });

  await logStudioUsage(req, { doc: saved, out, hadBlocks });
  res.json({ doc: saved, summary: sum, provider: out.provider });
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

  // What this turn is ADDING, not everything the document holds — see stagedFiles.
  const sent = stagedFiles(doc);
  await svc.appendMessages(doc._id, doc.owner, {
    role: "user",
    text,
    at: new Date(),
    ...(sent.length ? { files: sent } : {}),
  });
  // This turn is carrying them now, so they are no longer waiting to be carried.
  // By key, so a file attached while this turn was starting stays for the next.
  await svc.clearStaged(doc._id, doc.owner, sent.map((f) => f.key));
  /*
   * Which model this turn runs on. Sent with the turn rather than read off the
   * document, so a teacher who changes it in the composer gets the change on the
   * very next message instead of on the one after; validated against the
   * catalogue, because this string is handed to the provider. Remembered so the
   * choice sticks without being resent by every client.
   */
  const model = S.pickModel(String((req.body && req.body.model) || doc.settings?.model || ""));
  if (model !== doc.settings?.model) {
    await LessonDoc.updateOne({ _id: doc._id, owner: doc.owner }, { $set: { "settings.model": model } });
  }

  // The revision this turn answers; the commit at the end must still match it.
  const baseRevision = doc.revision || 0;

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

  /*
   * A stop button, and one that actually stops billing.
   *
   * Closing the browser tab or clicking Stop only ever closed the SOCKET before
   * this existed — the Claude request kept running on Anthropic's side, still
   * generating and still being paid for, for output nobody would ever read.
   * `req.on("close")` fires on exactly that disconnect (a deliberate abort from
   * the client, same as a real network drop), so the one signal aborts both the
   * plan call and the write call, whichever is in flight.
   */
  const ac = new AbortController();
  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
    clearInterval(hb);
    ac.abort();
  });

  const { runDocument, documentWithTools: runTools } = require("../helper/aiDocument");
  const { toGeminiSchema } = require("../helper/curriculumSchema");
  /*
   * Is there already a document, or is this the first turn?
   *
   * This asked whether there were BLOCKS, which an html document never has — so
   * every turn on one looked like a first turn. The model was handed the create
   * prompt, never saw the material it was meant to be changing, and rebuilt it
   * from the attached file: a teacher asking to remove blank rows got their
   * translation and their colour thrown away and the English original back.
   * Everything downstream rode on the same flag, so the turn was also logged as a
   * generation and recorded in the transcript as "created".
   */
  const hadBlocks = S.countParts(doc) > 0;
  // Attached references travel with every turn, and with the PLAN too — deciding
  // what to write from a page the model cannot see is deciding blind.
  /*
   * What this turn ATTACHED, not everything the document has ever held.
   *
   * Files stay on the document, and every one of them was re-encoded and resent on
   * every turn afterwards. A teacher who attached a textbook page in turn one and
   * typed "make it shorter" in turn nine paid to upload that page nine times —
   * and, worse than the cost, the model kept being handed a source together with
   * instructions about sources on a turn that was about the document.
   *
   * The bytes are needed once. What has to persist is the KNOWLEDGE that the file
   * was sent and what came of it, and that lives in the transcript now: the
   * history names each attachment on the turn it arrived, so "the file I sent
   * earlier" stays answerable without shipping it again.
   */
  /*
   * Until a source has actually BEEN read, it keeps being sent.
   *
   * "Only this turn's attachments" was right about cost and wrong about a first
   * draft. A teacher attached ÇEVRƏ.pdf with "copy exactly as is"; the model
   * answered that turn by calling set_print_options, so nothing was written and
   * nothing was read — and from the next turn on the file was no longer sent,
   * because it was no longer newly attached. The model then wrote about the
   * document's TITLE, which was the only subject it had, and the teacher watched
   * their circles PDF turn into a lesson on inequalities.
   *
   * `sourceNotes` is the record of having read something. While it is empty, no
   * turn has ever seen inside these files, so no turn can be expected to know
   * them: they travel. Once one has, the notes carry the knowledge and
   * read_source fetches the page itself when the work needs the page. Bounded by
   * a fact about the document rather than by a guess about the request.
   */
  const neverRead = !(doc.sourceNotes || []).length;
  const sending = (doc.files || []).filter(
    (f) => neverRead || sent.some((x) => x.key === f.key)
  );
  const { parts, unreadable } = await require("../helper/lessonDocFiles").toParts(sending);

  // Declared outside the try so a stop mid-write can still see what the plan
  // committed to and what had actually been written, and salvage it below.
  let plan = null;
  let lastSnapshot = "";
  // Committed with the turn rather than on their own, so a document never gains
  // notes about a turn that failed before it wrote anything.
  let notesToKeep = null;

  try {
    /*
     * The source check belongs INSIDE the try. The 200 and the SSE headers went
     * out several lines ago, so throwing past this point would leave Express with
     * nothing to write the error onto and the socket would just die — the client
     * would see a stream that ended with no terminal event, which is precisely
     * the ambiguity this file is trying to remove.
     */
    assertSourcesReadable(sending, parts, unreadable);
    if (unreadable.length) send("source_warning", { unreadable });

    /*
     * ---- phase 1: what are we about to do? ---------------------------------
     *
     * Runs for an EDIT as well as a creation. It used to be creation-only, which
     * left every change showing nothing but "Dəyişirəm…" for the length of a long
     * call — a spinner with a word on it. Now both paths answer the question the
     * teacher is actually asking while they wait: what did you understand, and
     * what are you about to do to my document.
     */
    send("phase", { phase: "plan", editing: hadBlocks });
    try {
      const p = await runDocument({
        ...S.buildPlanPrompt({ doc: doc.toObject(), instructions: text, editing: hadBlocks }),
        parts,
        schema: S.PLAN_SCHEMA,
        geminiSchema: toGeminiSchema(S.PLAN_SCHEMA),
        maxTokens: 1200,
        // The whole turn runs where the teacher chose. This pass used to route
        // itself, so choosing Gemini still planned on OpenAI and billed there.
        model,
        provider: S.providerOf(model),
        signal: ac.signal,
      });
      plan = S.normalizePlan(p.doc || {});
      /*
       * What it read, before what it intends to write.
       *
       * Sent as its own event and shown first, because it answers a different and
       * more basic question than the plan does: not "what will you do" but "did
       * you actually open my file". A model that can name the topics and count the
       * exercises on the page has demonstrably read it; one that reports
       * `readable: false` has told the teacher something they could not otherwise
       * have discovered until the material came back subtly invented.
       */
      if (plan.sources.length) send("sources", { sources: plan.sources });
      /*
       * Written down the first time they are read, and kept.
       *
       * The file itself travels only on request, so without this the model's
       * knowledge of the source lasted exactly one turn — the design it studied
       * on turn one was gone by turn three, and "make it like the PDF" was being
       * asked of something that had never seen a PDF. A few hundred characters of
       * what it saw ride along on every turn from here; the page itself is still
       * a read_source away when the work needs the page.
       */
      if (plan.sources.length && !(doc.sourceNotes || []).length) {
        notesToKeep = plan.sources
          .filter((x) => x && x.readable && x.found)
          .map((x) => ({ name: String(x.name || "").slice(0, 80), found: String(x.found).slice(0, 400) }));
        /*
         * Written HERE, not with the document.
         *
         * These were only saved on the path where a document got written — so
         * the turn that read the PDF and answered by changing a print setting
         * threw away everything it had learned from it, and the next turn had
         * neither the file nor any note about it. Reading is what happened;
         * whether the model then wrote, adjusted a setting or asked a question
         * does not change that. Not a content write, so it does not take the
         * revision or contend with one.
         */
        if (notesToKeep.length) {
          await LessonDoc.updateOne(
            { _id: doc._id, owner: doc.owner },
            { $set: { sourceNotes: notesToKeep } }
          ).catch((e) => console.error("[LESSON DOC] source notes not saved:", e?.message));
        }
      }
      if (plan.sections.length) send("plan", { ...plan, editing: hadBlocks });
    } catch (e) {
      // A stop must stop the TURN, not just this one call — swallowing it here
      // would run the far more expensive write pass anyway, right after the
      // teacher asked to cancel.
      if (ac.signal.aborted) throw e;
      /*
       * Any other failed plan is not a failed turn — the writing pass can still
       * run, it just runs without a preview. But it must SAY so: swallowing this
       * silently left the UI implying a planned workflow that never happened, and
       * the teacher reading "I am writing it" had no way to know the model never
       * committed to a shape first.
       */
      plan = null;
      console.error("[LESSON DOC] plan pass failed:", e?.message);
      send("planning_degraded", { message: "Plan hazırlanmadı — birbaşa yazıram." });
    }

    // ---- phase 2: write it, reporting each block -----------------------------
    send("phase", { phase: "write", sections: plan?.sections?.length || 0 });

    /*
     * Did a file arrive WITH this message? That is the teacher pointing at it,
     * and it changes what their words mean: "keep everything the same" said over
     * an attachment is about the attachment, not about the document they are
     * asking to replace.
     */
    const freshFiles = sent.length > 0;
    const base = hadBlocks
      ? S.buildEditPrompt({ doc: doc.toObject(), instructions: text, freshFiles })
      : S.buildCreatePrompt({ doc: doc.toObject(), instructions: text });
    /*
     * The source rules turn an attachment into the thing to reproduce — copy mode
     * and all. That is exactly right on the first turn and exactly wrong on the
     * tenth: the files stay attached for the life of the document, so every later
     * edit was still being told "the file is the primary source, copy it as it
     * is", and the model dutifully rebuilt the document from the PDF instead of
     * changing it. On an edit the document is the subject and the file is only
     * reference, which is what EDIT_RULES already says.
     */
    if (parts.length && (freshFiles || !hadBlocks)) {
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

    // The document arrives as html now, so progress counts closed tags.
    const readBlocks = S.makeHtmlStreamer();
    let seen = 0;
    const onText = (snapshot) => {
      lastSnapshot = snapshot;
      for (const b of readBlocks(snapshot)) {
        seen += 1;
        // The block itself, so the client can name what just landed rather than
        // counting anonymously.
        send("block", { n: seen, kind: String(b.kind || ""), text: String(b.text || b.term || "").slice(0, 90) });
      }
    };

    /*
     * The agent picks a tool. A request about how the document PRINTS calls
     * set_print_options and never touches a block; a request about what it SAYS
     * calls write_material. That choice is the whole point — it is why "add page
     * numbers" can no longer come back as the words "Səhifə 1" typed into a
     * lesson, and why a print change is instant instead of a full rewrite that
     * might mangle the document on the way past.
     */
    const out = await runTools({
      system: base.system,
      prompt,
      parts,
      tools: S.DOC_TOOLS,
      model,
      // Which API this id belongs to. The loop is the same on all three; only the
      // wire format differs, and the adapter owns that.
      provider: S.providerOf(model),
      signal: ac.signal,
      onText,
      /*
       * Checked before it is accepted, not asked for in the brief.
       *
       * A row that stops short of the table's width is arithmetic — no source is
       * needed to see it — and it is the mistake that quietly changes what a
       * timetable SAYS: drop the empty cells for the weeks with no lecture and
       * every date after them slides left, moving a lecture into a month it does
       * not happen in. The finding goes back to the model as a tool error while
       * the source is still in front of it.
       */
      validate: (name, input) => {
        if (name !== "write_material") return "";
        const raw = input.html || "";
        const findings = [checkTables(raw)];
        /*
         * Tell it what we deleted. The allow-list is silent by design, so a
         * design instruction it wrote and we refused looked, from where it stood,
         * exactly like an instruction that had been carried out — it would write
         * the same thing again on the next turn and the copy would come back flat
         * a second time, with both sides sure they had done the work.
         */
        const gone = droppedStyles(raw, sanitizeDocHtml(raw));
        if (gone.length) {
          findings.push(
            `Bu style xüsusiyyətləri sənəddə saxlanmır və silindi: ${gone.join(", ")}. ` +
              "İcazə verilənlərlə eyni görünüşü ver (rəng, kənar xətt, en, hizalama, " +
              "writing-mode, transform:rotate, table-layout) və ya o detaldan imtina et."
          );
        }
        return findings.filter(Boolean).join("\n\n");
      },
      /*
       * Serve a source the model asks for. Every file the document holds is
       * reachable this way, not just the ones attached on this turn — which is the
       * whole point: the bytes travel on request instead of on every turn, and a
       * PDF attached ten turns ago is still the thing a copy gets made from.
       *
       * Matched on the name the teacher's file actually has, loosely enough to
       * survive the model retyping it, and never on anything but this document's
       * own list.
       */
      /*
       * Let it look at what it wrote — but only when there is a source to compare
       * against, which is what makes the comparison worth a browser render. A
       * material written from a teacher's description has nothing to be checked
       * for fidelity TO.
       */
      /*
       * Every turn gets the page count; only source work gets the pictures.
       *
       * "I asked for two pages and got five" is a fault on every kind of turn,
       * and the count comes from the same browser session that would take the
       * screenshots — so measuring it always is one render, while sending four
       * images always would be four images of tokens on a turn with nothing to
       * compare them against.
       */
      look: async (html) => {
        if (!html) return null;
        try {
          const { renderPng } = require("../helper/lessonPlanPdf");
          const clean = sanitizeDocHtml(html);
          if (!clean) return null;
          const hasSource = sending.length > 0 || (doc.files || []).length > 0;
          return await renderPng(buildLessonDocHtml({ ...doc.toObject(), html: clean }), {
            timeoutMs: 20000,
            bands: hasSource,
          });
        } catch (e) {
          // A failed render must cost the teacher nothing: skip the look and let
          // the turn finish on the checks that did run.
          console.error("[LESSON DOC] draft render failed:", e?.message);
          return null;
        }
      },
      /*
       * The arithmetic that goes with the picture: which columns each cell lands
       * on. A cell holding a long sentence stretches its column, so a block
       * sitting on ONE column can look exactly like a block spanning seven —
       * which is how a class that runs three weeks came back looking like it runs
       * eleven, with both sides describing the same image and meaning different
       * markup.
       */
      gridOf: (html) => gridMap(html || ""),
      // An empty document that comes back with only a print setting changed is a
      // turn that did not do what was asked — see the loop for what happened.
      needsDocument: !hadBlocks,
      fetchSource: async (name) => {
        const want = String(name || "").trim().toLowerCase();
        if (!want) return null;
        const all = doc.files || [];
        const hit =
          all.find((f) => String(f.name || "").toLowerCase() === want) ||
          all.find((f) => String(f.name || "").toLowerCase().includes(want)) ||
          all.find((f) => want.includes(String(f.name || "").toLowerCase()));
        if (!hit) return null;
        const { parts: got } = await require("../helper/lessonDocFiles").toParts([hit]);
        return got.length ? { name: hit.name, part: got[0] } : null;
      },
    });

    const wrote = out.calls.find((c) => c.name === "write_material");
    const printed = out.calls.find((c) => c.name === "set_print_options");
    const asked = out.calls.find((c) => c.name === "ask_teacher");

    /*
     * A question, and the document untouched.
     *
     * Answered FIRST, and only when nothing was written, because a model that has
     * decided it does not understand must not also be changing the material — the
     * whole point of the tool is that guessing is no longer the only move.
     */
    if (asked && !wrote && !printed) {
      const withQuestion = await svc.appendMessages(doc._id, doc.owner, {
        role: "assistant",
        text: String(asked.input.question || "").trim() || out.said || "Nə etməyimi istəyirsiniz?",
        action: "asked",
        at: new Date(),
      });
      await logStudioUsage(req, { doc: withQuestion || doc, out, hadBlocks });
      send("done", { doc: withQuestion || doc, summary: null, provider: out.provider });
      return;
    }

    /*
     * A settings-only turn. Nothing about the document's content changed, so
     * nothing about it is rewritten — the setting is committed on its own and the
     * teacher gets the model's sentence about it.
     */
    if (printed && !wrote) {
      const saved = await svc.commit(
        doc._id,
        doc.owner,
        printOptions(printed.input),
        baseRevision,
        {
          push: {
            messages: {
              role: "assistant",
              text: printed.input.reply || out.said || "Çap parametrləri yeniləndi.",
              action: "settings",
              at: new Date(),
            },
          },
        }
      );
      await logStudioUsage(req, { doc: saved, out, hadBlocks });
      send("done", { doc: saved, summary: S.summarize(saved.blocks || []), provider: out.provider });
      return;
    }

    if (printed && wrote) {
      // Both, in one turn: apply the setting first so the content commit below is
      // the single write that moves the revision.
      await LessonDoc.updateOne({ _id: doc._id, owner: doc.owner }, { $set: printOptions(printed.input) });
    }

    if (!wrote) {
      /*
       * Send back what the database now holds, NOT the copy read at the top of
       * this turn.
       *
       * `doc` was fetched before the teacher's own message was pushed and before
       * this reply was, so handing it to the client — which replaces its state
       * with whatever `done` carries — erased both from the conversation the
       * moment the turn ended. It read as the turn vanishing.
       */
      const saved = await svc.appendMessages(doc._id, doc.owner, {
        role: "assistant",
        text: out.said || "Bu dəyişikliyi edə bilmədim.",
        action: "noop",
        at: new Date(),
      });
      const fresh = saved || doc;
      send("done", { doc: fresh, summary: S.summarize(fresh.blocks || []), provider: out.provider });
      return;
    }
    /*
     * The model wrote the document; this is where it becomes safe to store.
     *
     * Sanitised BEFORE it touches the database, so nothing unsafe is ever at rest
     * and every reader — the preview, the PDF, Word — can trust what it holds
     * without re-checking. An input that sanitises to nothing was not a document.
     */
    const html = sanitizeDocHtml(wrote.input.html);
    if (!html) {
      await svc.appendMessages(doc._id, doc.owner, {
        role: "assistant",
        text: "Material boş qayıtdı — istəyinizi bir az dəqiqləşdirin.",
        action: "failed",
        at: new Date(),
      });
      send("failed", { code: "validation_failed", message: "Material boş qayıtdı — istəyinizi dəqiqləşdirin." });
      return;
    }

    const sum = summarizeHtml(html);
    const saved = await svc.commit(
      doc._id,
      doc.owner,
      {
        html,
        // What the library card counts. Derived once here rather than by
        // re-scanning the html on every list query.
        partCount: sum.blocks,
        // Blocks belonged to the old representation. Clearing them keeps one
        // source of truth per document rather than two that can disagree.
        blocks: [],
        ...(wrote.input.title ? { title: wrote.input.title } : {}),
        ...(!doc.topic && wrote.input.title ? { topic: wrote.input.title } : {}),
        ...(plan?.audience && !doc.audience ? { audience: plan.audience } : {}),
        status: "ready",
        aiMeta: { provider: out.provider, at: new Date() },
      },
      baseRevision,
      {
        push: {
          messages: {
            role: "assistant",
            /*
             * The model's own words, not ours stapled onto them.
             *
             * A finding from the table check is handed BACK to the model — see the
             * validate loop in helper/aiDocument — so the model is the one that
             * knows what it could and could not resolve, and says so in the reply
             * it writes. This file appending its own sentence would be guessing at
             * that from the outside, in fixed wording, for one shape of problem.
             */
            text: wrote.input.reply || (hadBlocks ? "Dəyişdirildi." : "Material hazırdır."),
            action: hadBlocks ? "edited" : "created",
            stats: sum,
            ...(plan && (plan.sources?.length || plan.sections?.length)
              ? { work: { sources: plan.sources || [], steps: plan.sections || [] } }
              : {}),
            at: new Date(),
          },
        },
      }
    );

    await logStudioUsage(req, { doc: saved, out, hadBlocks });
    send("done", { doc: saved, summary: sum, provider: out.provider });
    return;
  } catch (e) {
    // A deliberate stop is not a failure — it must not read like "Alınmadı" in
    // the transcript, and there is no client left to send an SSE frame to.
    if (ac.signal.aborted || e?.aiStatus === 499) {
      /*
       * Salvage whatever had actually been written before the stop landed.
       *
       * The same repair that recovers a response cut off by the token ceiling
       * recovers one cut off by a deliberate Stop click — both are "valid JSON up
       * to some point, then nothing." The blocks the teacher watched arrive in the
       * live progress view were real; discarding them because the LAST one never
       * finished would make Stop punish the teacher for using it.
       */
      let salvaged = false;
      if (lastSnapshot) {
        try {
          const repaired = require("../helper/aiDocument").repairTruncatedJson(lastSnapshot);
          const keepIds = (doc.blocks || []).map((b) => b.id);
          const next = repaired ? S.normalizeDoc(repaired, { keepIds }) : null;
          if (next?.blocks?.length) {
            /*
             * Salvage still goes through the CAS. A stop is not a licence to
             * overwrite: if the teacher edited a block while this turn was
             * running, the half-written version they cancelled must not win over
             * the edit they made deliberately. Losing here is the right outcome
             * and leaves the plain "Dayandırıldı." note below.
             */
            await commitTurn(doc, baseRevision, {
              next,
              // The provider that was actually running when the stop landed,
              // named by runDocument — never a guessed brand.
              out: { provider: e?.provider || "unknown" },
              hadBlocks,
              sum: S.summarize(next.blocks),
              reply: "Dayandırıldı — buraya qədər olan hissə saxlanıldı.",
              audience: plan?.audience,
              plan,
            });
            salvaged = true;
          }
        } catch {
          /* nothing usable, or a newer revision won — fall through to the note */
        }
      }
      if (!salvaged) {
        await svc
          .appendMessages(doc._id, doc.owner, { role: "assistant", text: "Dayandırıldı.", action: "stopped", at: new Date() })
          .catch(() => {});
      }
    } else {
      const pub = publicFailure(e);
      await svc
        .appendMessages(doc._id, doc.owner, { role: "assistant", text: pub.message, action: "failed", at: new Date() })
        .catch(() => {});
      send("failed", pub);
    }
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
  /*
   * The same page attached twice is one entry, not two identical ones in the
   * list — but it IS attached again. Re-uploading a file the document already
   * holds used to return the document untouched, so the teacher's upload
   * completed and nothing happened; the only way to reuse a page was to have
   * never used it. One entry, freshly staged.
   */
  if (files.some((x) => x.key === saved.key)) {
    const restaged = await svc.stageFile(doc._id, doc.owner, saved.key);
    return res.status(201).json({ doc: restaged || doc });
  }
  /*
   * An attachment is document content — it changes what every later turn is
   * grounded in — so it takes the same CAS as any other write. Attaching from two
   * tabs at once now conflicts loudly instead of one list silently replacing the
   * other.
   */
  const withFile = await svc.commit(doc._id, doc.owner, {}, doc.revision || 0, {
    push: { files: { ...saved, stagedAt: new Date() } },
  });
  res.status(201).json({ doc: withFile });
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

  const without = await svc.commit(
    doc._id,
    doc.owner,
    { files: (doc.files || []).filter((x) => x.key !== key) },
    doc.revision || 0
  );

  // Content-addressed, so another material may hold the identical file. The
  // reference check runs AFTER the row is committed: unlinking bytes that a
  // failed commit left referenced is the one ordering that loses data.
  const stillUsed = await LessonDoc.exists({ _id: { $ne: doc._id }, "files.key": key });
  await F.removeIfUnused(key, gone.ext, Boolean(stillUsed));
  res.json({ doc: without });
});

/*
 * PATCH /:id — the teacher's own edit.
 *
 * Free, exact and never routed through the model: fixing a typo should not cost a
 * credit or risk the rest of the document being rewritten. Guarded by the same
 * revision CAS as lesson plans so two tabs cannot silently overwrite each other.
 */
/*
 * PATCH /:id — the teacher's own edit.
 *
 * `revision` is now REQUIRED. It used to be checked only when the client happened
 * to send it (`if (b.revision !== undefined)`), which made a blind write a
 * supported call: two tabs both read revision 4, both write, and the second one
 * silently discards the first. And even when sent, the comparison happened in
 * JavaScript between a findById and a save() — a window wide enough to lose an
 * edit through, which is exactly what a compare-and-set exists to close.
 */
const updateDoc = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const b = req.body || {};

  const patch = {};
  for (const f of ["title", "topic", "subject", "grade", "audience"]) {
    if (b[f] !== undefined) patch[f] = String(b[f] || "").trim();
  }
  if (b.format !== undefined) patch.format = b.format === "docx" ? "docx" : "pdf";

  if (Array.isArray(b.blocks)) {
    // Run the teacher's blocks through the SAME normaliser as the model's, so a
    // hand-edited document cannot end up in a shape the renderer has never seen.
    const kept = S.normalizeDoc(
      { title: patch.title || doc.title, blocks: b.blocks },
      { keepIds: b.blocks.map((x) => x && x.id) }
    );
    patch.blocks = kept.blocks;
  }

  res.json({ doc: await svc.commit(doc._id, doc.owner, patch, b.revision) });
});

// DELETE /:id
const removeDoc = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const gone = await LessonDoc.deleteOne({ _id: doc._id });
  // Only give the slot back if this request is the one that actually removed the
  // row — a double-click would otherwise refund twice for one deletion.
  if (gone.deletedCount === 1) {
    await svc.releaseDocSlot(require("../models/userModel"), doc.owner);
  }
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
  // Same blindness, worse consequence: a finished html document could not be
  // exported at all, because the emptiness test only knew how to see blocks.
  if (!S.countParts(doc)) {
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
    // Page numbers only — no product name on a document the teacher hands out —
    // and only when the document says it wants them. That flag is what the AI's
    // set_print_options tool writes, which is why "add page numbers" is a real
    // change to a real setting rather than words typed into the content.
    body = await renderPdf(buildLessonDocHtml(plain), {
      footerLabel: null,
      pageNumbers: doc.settings?.pageNumbers !== false,
    });
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
// Exported for the redaction test: the funnel that decides what a teacher is
// allowed to see is worth asserting on directly, not only through a live stream.
module.exports.publicFailure = publicFailure;
module.exports.assertSourcesReadable = assertSourcesReadable;
