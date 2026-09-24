const asyncHandler = require("express-async-handler");
const LessonDoc = require("../models/lessonDocModel");
const { httpError, isAppError } = require("../utils/appError");
const S = require("../helper/lessonDocSchema");
const { checkTables, gridMap } = require("../helper/lessonDocTables");
const { applyEdits } = require("../helper/lessonDocPatch");
const { buildLessonDocHtml } = require("../helper/lessonDocHtml");
// Every write to a document goes through here. No path in this file may call
// doc.save() — see the header of services/lessonDocService.js for why.
const svc = require("../services/lessonDocService");
const { meterFor } = require("../middleware/aiCredit");
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
 * An admin is exempt: they may read any material, so there is no foreign
 * document for them to be refused and nothing to disguise.
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
  // An admin reads every material, so they never reach this: the old ternary
  // here offered them a 403 that no code path could produce.
  if (!admin && String(doc.owner) !== String(req.user._id)) throw missing();
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
 * The only shape a Studio failure takes in the logs.
 *
 * Six sites logged `e.message`. A provider error carries fragments of the
 * request, model output, a source filename, sometimes a URL with credentials in
 * it; a Mongo error carries the connection string. The SSE path was closed to
 * that a while ago (publicFailure below curates what the teacher sees), and the
 * log line was the channel left open. This writes a stable event name and the
 * error's CODE — nothing the error composed itself. A canary test throws an
 * error stuffed with secrets through every path and asserts none reach the
 * console.
 */
const logStudioEvent = (event, e, extra) => {
  const code =
    typeof e?.code === "string" ? e.code : Number.isFinite(e?.aiStatus) ? `ai_${e.aiStatus}` : e ? "unknown" : "";
  const status = Number.isFinite(e?.status) ? e.status : Number.isFinite(e?.aiStatus) ? e.aiStatus : null;
  const provider = typeof e?.provider === "string" ? e.provider : null;
  console.error(`[LESSON DOC] ${event}`, JSON.stringify({ code, status, provider, ...(extra || {}) }));
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * The turn, narrated.
 *
 * Every line the teacher sees while a turn runs comes from here, from a code
 * and a few numbers the loop reported — never from model text, and never
 * from a timer. It is the difference between "Yazıram…" for eleven minutes
 * and knowing that the model is on its second read of the PDF, that the draft
 * is being rendered to count its pages, that one table row went back to be
 * fixed. Returns "" for anything not worth a line.
 */
/*
 * How hard the model thinks, and why this is the cost dial.
 *
 * Thinking bills at the OUTPUT rate. Measured on a real creation — copy a
 * 0.4 MB PDF, 16 minutes, $3.18 — the finished document was ~11,800 tokens
 * and the turn produced 92,721 output tokens: the document twice over, and
 * roughly 69,000 tokens of thinking at `high`. On a transcription task that
 * reasoning buys very little, and the teacher pays $25 per million for it.
 *
 * `medium` is the default for both now. It is a dial rather than a constant
 * because the right setting is a judgement about the work, and the owner can
 * move it without a deploy: STUDIO_EFFORT_CREATE / STUDIO_EFFORT_EDIT accept
 * low | medium | high.
 */
const EFFORT = new Set(["low", "medium", "high"]);
const effortFrom = (value, fallback) =>
  EFFORT.has(String(value || "")) ? String(value) : fallback;
const EFFORT_CREATE = effortFrom(process.env.STUDIO_EFFORT_CREATE, "medium");
const EFFORT_EDIT = effortFrom(process.env.STUDIO_EFFORT_EDIT, "medium");

function activityText(kind, d) {
  const n = Number(d.n) || 0;
  switch (kind) {
    case "files":
      return `Fayllar hazırlanır: ${(d.names || []).join(", ")}`;
    case "plan":
      return d.editing
        ? `${d.model} istəyi oxuyur və addımları planlaşdırır`
        : `${d.model} mənbələri oxuyur və planı hazırlayır`;
    case "planned":
      return (
        `Plan hazırdır — ${d.steps || 0} addım` +
        (d.sources ? `, ${d.readable || 0}/${d.sources} mənbə oxundu` : "")
      );
    case "plan_failed":
      return "Plan hazırlanmadı — birbaşa yazılır";
    case "write":
      return d.editing
        ? `${d.model} dəyişikliyi hazırlayır — düşünür`
        : `${d.model} sənədi yazmağa başlayır — düşünür`;
    case "round":
      return (
        {
          after_read: "Mənbə alındı — davam edir",
          after_look: "Görüntüyə baxır və qərar verir",
          after_finding: "Tapılan problemi düzəldir",
          after_nudge: "Alət çağırışı gözlənilir",
          after_settings: "Məzmunu yazmağa keçir",
          after_refused: "Əlindəki məlumatla davam edir",
        }[d.reason] || `${d.n || ""}-ci çağırış`
      );
    case "read":
      return `Mənbəni oxumaq istəyir: ${d.name || "fayl"}${d.pages ? `, səh. ${d.pages}` : ""}`;
    case "served":
      return d.ok
        ? `Göndərildi: ${d.name}${d.from ? `, səh. ${d.from}-${d.to}` : ""}${d.total ? ` (cəmi ${d.total} səh.)` : ""}`
        : `${d.name || "Fayl"}: istənilən səhifə tapılmadı`;
    case "refused_read":
      return "Oxu limiti doldu — əlindəki məlumatla yazır";
    case "wrote": {
      const c = d.call || {};
      if (c.name === "edit_material") return `Dəyişiklik gəldi: ${(c.input?.edits || []).length} parça`;
      return `Sənəd yazıldı: ${S.countParts({ html: c.input?.html || "" })} hissə`;
    }
    case "settings":
      return "Çap parametrləri dəyişdirilir";
    case "settings_only":
      return "Yalnız parametr dəyişdi, məzmun yazılmadı — modelə bildirildi";
    case "asked":
      return "Sual verir — cavabınızı gözləyəcək";
    case "nudge":
      return "Model mətni təsvir etdi, aləti çağırmadı — yenidən istənildi";
    case "look":
      return "Görünüş yoxlanılır — sənəd Chromium ilə PDF-ə çevrilir";
    case "looked":
      return d.pages
        ? `PDF-də ${d.pages} səhifə çıxır${d.bands ? " — görüntü modelə göndərildi" : " — say modelə bildirildi"}`
        : "Görüntü modelə göndərildi";
    case "finding":
      return `Yoxlamada ${n} problem tapıldı — düzəliş üçün modelə göndərildi`;
    case "agree":
      return "Model təsdiqlədi — dəyişiklik lazım deyil";
    case "unresolved":
      return `${n} problem həll olunmadı — sənəd olduğu kimi saxlanılır`;
    default:
      return "";
  }
}

/*
 * Debit the turn, exactly once, and say so on the stream.
 *
 * `usable()` is the one-shot the meter hands out; calling it twice is safe.
 * The `credits` event carries the charge and the estimated balance so the
 * header badge can move without a round trip — the client refetches the user
 * for the true figure, this is just for the badge not to lie for a second.
 * Nothing is sent for an unmetered turn (free op, billing off, admin).
 */
const chargeTurn = (req, send) => {
  const m = req.aiCredit;
  if (!m) return;
  m.usable();
  send("credits", { operation: m.operation, charged: m.cost, left: Math.max(0, m.balance - m.cost) });
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
  const AiUsage = require("../models/aiUsageModel");
  const c = (out && out.cost) || {};
  /*
   * Where the minutes went, by code and by number only.
   *
   * "It is very slow" had no answer until this line existed: nothing recorded
   * how long the plan took against the writing, how many provider rounds a
   * turn made, whether it read a source or looked at its render, or whether
   * the cache was hit. One line per finished turn, no text from anyone.
   */
  const t = (out && out.timing) || {};
  console.log(
    "[LESSON DOC] turn_done",
    JSON.stringify({
      op: hadBlocks ? "edit" : "generate",
      model: c.model || (out && out.provider) || "unknown",
      planMs: t.planMs || 0,
      writeMs: t.writeMs || 0,
      rounds: t.rounds || 0,
      reads: t.reads || 0,
      looked: Boolean(t.looked),
      fixes: t.fixes || 0,
      in: c.inputTokens || 0,
      out: c.outputTokens || 0,
      cacheRead: c.cacheReadTokens || 0,
      cacheWrite: c.cacheWriteTokens || 0,
      usd: c.usd || 0,
      parts: S.countParts(doc),
    })
  );
  const row = {
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
  };
  /*
   * Three attempts, because the moment this row fails to write is the moment
   * the database is having a bad second — which a single try turns into a turn
   * of paid provider work that no meter ever saw. Still best-effort at the end:
   * a usage row must not cost the teacher the material they waited for. But
   * the final failure is logged by CODE with the dollar amount, so the gap is
   * visible and recoverable rather than silent.
   */
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await AiUsage.create(row);
      return;
    } catch (e) {
      if (attempt === 2) logStudioEvent("usage_settlement_failed", e, { attempts: 3, usd: row.usd, operation: row.operation });
      else await wait(200 * 4 ** attempt);
    }
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
/*
 * What the document is made of, for the receipt and the library card.
 *
 * `blocks` is NOT counted here any more. It was — with its own copy of the
 * "what is a part" regex, and that copy is how this broke: a `\b` word
 * boundary went into the file as a literal BACKSPACE byte (0x08), so the
 * pattern demanded a control character after every tag name and matched
 * nothing. Every material committed since read `0 hissə` on its receipt and
 * `0` on its card while holding a hundred parts, and nothing failed loudly
 * enough to say so. Two copies of one rule, and only one of them rotted.
 *
 * So there is one rule now, in lessonDocSchema, and both callers use it —
 * this and `hadBlocks`, which decides whether a turn is a creation or an
 * edit. A canary in scripts/staticCheck.cjs refuses any shipping file that
 * contains a control character, so the class of fault cannot return silently.
 */
function summarizeHtml(html) {
  const count = (re) => (String(html).match(re) || []).length;
  return {
    blocks: S.countParts({ html }),
    examples: count(/class="[^"]*\bex\b/gi),
    tasks: count(/class="[^"]*\btask\b/gi),
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
  /*
   * Only what the caller actually set. This used to write pageNumbers on every
   * call, so a request that named a colour and nothing else switched page
   * numbers on as a side effect of asking for green.
   */
  const patch = {};
  if (input.pageNumbers !== undefined) patch["settings.pageNumbers"] = input.pageNumbers !== false;
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
  // Logged once, by code — never the message, which is the provider's to compose.
  logStudioEvent("turn_failed", e);
  const code = typeof e?.code === "string" && PUBLIC_FAILURE[e.code] ? e.code : null;
  /*
   * A known code does NOT make the message safe. This used to fall through to
   * `e.message` for any error carrying a recognised code, so a provider error
   * that happened to be tagged provider_unavailable handed its raw body — with
   * whatever request fragment, filename or URL it quoted — straight to the
   * teacher's toast. The canary test found it. Only text written FOR a teacher
   * passes: a docError's userMessage, an AppError's message, or the fixed line.
   */
  if (code) return { code, message: e.userMessage || (isAppError(e) ? e.message : "") || PUBLIC_FAILURE[code] };
  // A docError/AppError carries a message written for a teacher; anything else
  // is an internal detail and gets the generic line.
  const curated = e?.userMessage || (isAppError(e) ? e.message : "");
  return { code: e?.code || "generation_failed", message: curated || PUBLIC_FAILURE.generation_failed };
}

/*
 * How many of everyone's materials an admin's library will draw at once.
 *
 * A teacher's list is bounded by MAX_DOCS; the admin view has no such bound —
 * it is every teacher's list added together, and it grows with the platform.
 * The cap is what stops this route from one day building a response nobody can
 * render; `total` is reported alongside so the page can say what it is not
 * showing instead of silently presenting a truncated list as the whole truth.
 */
const ADMIN_LIST_CAP = Number(process.env.STUDIO_ADMIN_LIST_MAX || 500);

// GET /
/*
 * The library: a teacher's own materials, or EVERY teacher's for an admin.
 *
 * `mine()` has always let an admin open any document — supporting a teacher who
 * says "the table came out wrong" means looking at the material they are looking
 * at. But nothing ever listed those documents, so an admin could reach one only
 * by being handed its URL. Read access without discovery is not really access;
 * this is the missing half, and it is the same owner-scope-with-admin-override
 * that listBoards already uses.
 *
 * The owner's NAME is looked up here rather than stored on the document. A
 * denormalised copy is wrong the moment a teacher is renamed, and it would need
 * a backfill for every material that already exists.
 */
const listDocs = asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === "admin";
  const match = isAdmin
    ? { archivedAt: null }
    : { owner: req.user._id, archivedAt: null };

  const docs = await LessonDoc.aggregate([
    { $match: match },
    { $sort: { updatedAt: -1 } },
    ...(isAdmin ? [{ $limit: ADMIN_LIST_CAP }] : []),
    {
      $project: {
        title: 1, topic: 1, subject: 1, grade: 1, format: 1, status: 1, updatedAt: 1,
        // Needed to name the author and to mark a row as the admin's own. Kept
        // out of a teacher's response below — every row there is already theirs.
        owner: 1,
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

  // A teacher's own library — unchanged in shape, and `owner` never leaves the
  // server since it tells them nothing they do not already know.
  if (!isAdmin) {
    return res.json({ docs: docs.map(({ owner, ...d }) => d) });
  }

  /*
   * The authors, in ONE query for the whole page rather than one per row. Only
   * the owners actually present in this page of results are fetched.
   */
  const User = require("../models/userModel");
  const ownerIds = [...new Set(docs.map((d) => String(d.owner)).filter(Boolean))];
  const authors = await User.find({ _id: { $in: ownerIds } }).select("name email").lean();
  const authorOf = new Map(authors.map((u) => [String(u._id), u]));

  const total = await LessonDoc.countDocuments(match);
  res.json({
    admin: true,
    total,
    docs: docs.map(({ owner, ...d }) => {
      const author = authorOf.get(String(owner));
      return {
        ...d,
        mine: String(owner) === String(req.user._id),
        // A deleted account leaves its materials behind; say so rather than
        // rendering a card with a blank author.
        ownerName: author?.name || "Silinmiş istifadəçi",
        ownerEmail: author?.email || "",
      };
    }),
  });
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
 * There is ONE way an AI turn changes a document: the streaming turn below.
 *
 * A second, non-streaming POST /:id/message used to sit beside it and ran the
 * older whole-document generation — no tool loop, no patch edits, no render
 * check, no read_source. The app had stopped calling it, but it was still
 * mounted, so any old client or direct caller could rewrite a material through a
 * path that none of the guarantees on this page applied to. Two editing
 * contracts that evolve separately is a bug factory; there is now one.
 */
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
/*
 * Cost-bounded content generation. The legacy path below is retained for old
 * documents and can be re-enabled with LESSON_DOC_NATIVE_ENGINE=false while a
 * deployment is being rolled out. New turns use one structured request and the
 * platform renderer; there is no planning call, tool loop, screenshot round, or
 * model-authored CSS/SVG.
 */
async function runNativeMaterialTurn({ req, doc, text, parts, files, model, abortSignal, hadBlocks, baseRevision, send }) {
  const native = require("../helper/lessonDocNative");
  // One structured request, and nothing else: no planning call, no tool loop, no
  // screenshot round. This is the whole model interaction for a turn.
  const { runDocument: runStructured } = require("../helper/aiDocument");
  /*
   * The model the teacher chose is the model that runs.
   *
   * This used to rewrite any non-OpenAI selection to a cheap model, which meant
   * the picker said "Claude Opus 5" while the turn ran something else — and the
   * usage row recorded the one that ran. The list is ordered so the cheap
   * platform engine is the DEFAULT; choosing something dearer is then a decision
   * someone made on purpose, and the label stays true.
   */
  const chosen = S.DOC_MODELS.find((entry) => entry.id === model);
  /*
   * The picker wins. LESSON_NATIVE_MODEL is a fallback for when no known model
   * was chosen, never an override: as an override it could run something other
   * than the name on screen, which is the exact divergence docModelParity warns
   * about — the teacher reads one model and the usage row records another.
   */
  const nativeModel = String(chosen?.id || process.env.LESSON_NATIVE_MODEL || S.DEFAULT_DOC_MODEL);
  const nativeProvider = /^claude/i.test(nativeModel)
    ? "claude"
    : /^gemini/i.test(nativeModel)
      ? "gemini"
      : "openai";
  const started = Date.now();
  send("phase", { phase: "content", editing: hadBlocks, engine: "platform" });
  send("activity", {
    kind: "native_engine",
    text: "Məzmun hazırlanır — görünüş, sxemlər və PDF platformada qurulur.",
    at: Date.now(),
  });

  const current = doc.aiMeta?.native && typeof doc.aiMeta.native === "object" ? doc.aiMeta.native : null;
  /*
   * Local extraction runs over EVERY file the document holds, not just the ones
   * this turn is sending.
   *
   * The legacy engine keeps older attachments out of the request and reaches
   * back into them with a read_source tool when it needs a page. This engine has
   * no tools, so the same filter meant a material forgot its textbook after the
   * first turn: edit three turns later and the model was working from the chat
   * alone. Reading them here costs nothing — it is Ghostscript on our own disk —
   * and it is the only way a later edit still knows what the source said.
   */
  const lessonFiles = require("../helper/lessonDocFiles");
  const sourceText = await lessonFiles.nativeSourceText(doc.files || []);
  /*
   * Keyed by the file KEY, not its name. Matching on `part.name` was matching
   * on undefined — parts carried no name — so the filter below never dropped a
   * single PDF and every textbook was sent as vision input AND as extracted
   * text in the prompt. A key is a content hash: unique, always present, and
   * impossible to confuse with another file that happens to share a filename.
   */
  const readByKey = new Map(sourceText.map((x) => [x.key, x]));
  /*
   * A PDF is dropped from the paid request only when the local read replaces it
   * completely: text was found AND the whole document was covered. A scan, or a
   * textbook longer than the local read, keeps its file part — otherwise the
   * answer to "the exercise on page 30" is in the part nobody sent.
   */
  const partsForModel = parts.filter((part) => {
    if (!part.isPdf) return true;
    const read = readByKey.get(part.key);
    return !(read && read.complete);
  });
  if (partsForModel.length < parts.length) {
    // Worth saying in the log, because this line IS the cost saving: without it
    // the expensive half of the request is still being sent.
    console.log(
      `[LESSON DOC] native turn: ${parts.length - partsForModel.length}/${parts.length} PDF(s) replaced by local text`
    );
  }
  const localPrint = native.nativePrintOptions(text);
  if (localPrint) {
    const saved = await svc.commit(
      doc._id,
      doc.owner,
      printOptions(localPrint),
      baseRevision,
      {
        push: {
          messages: {
            role: "assistant",
            text: "Çap parametrləri platformada yeniləndi.",
            action: "settings",
            work: { engine: "platform-local", rounds: 0, renderer: "lessonDocHtml" },
            at: new Date(),
          },
        },
      }
    );
    await logStudioUsage(req, {
      doc: saved,
      hadBlocks,
      out: { provider: "platform-local", cost: { model: "platform-local", usd: 0 }, timing: { rounds: 0 } },
    });
    chargeTurn(req, send);
    // Summarised from the BODY, not from `blocks`: a platform-rendered material
    // keeps its content in `html` and no blocks at all, so counting blocks would
    // report a finished material as empty every time a print setting changed.
    send("done", {
      doc: saved,
      summary: saved.html ? summarizeHtml(saved.html) : S.summarize(saved.blocks || []),
      provider: "platform-local",
      engine: "platform-native",
    });
    return;
  }
  const out = await runStructured({
    prompt: native.nativePrompt({ request: text, current, sourceNotes: doc.sourceNotes || [], sourceText }),
    parts: partsForModel,
    system: native.NATIVE_SYSTEM,
    schema: native.NATIVE_SCHEMA,
    geminiSchema: native.NATIVE_SCHEMA,
    model: nativeModel,
    provider: nativeProvider,
    signal: abortSignal,
    maxTokens: 10000,
  });
  /*
   * A cut-off answer is not a document.
   *
   * The provider reports when it stopped mid-structure, and that was ignored:
   * a reply containing one heading and one paragraph passed the checks below
   * and REPLACED a forty-block material. Nothing else in this path can tell the
   * difference, because a truncated answer is perfectly well-formed as far as
   * the schema is concerned — it is simply missing everything after the cut.
   */
  if (out.truncated) {
    await logStudioUsage(req, { doc, hadBlocks, out: { ...out, timing: { rounds: 1, failed: true } } }).catch(() => {});
    const e = new Error("truncated_native_document");
    e.aiStatus = 422;
    e.userMessage = hadBlocks
      ? "Cavab yarımçıq gəldi, material dəyişdirilmədi. Yenidən cəhd edin."
      : "Cavab yarımçıq gəldi. Yenidən cəhd edin.";
    throw e;
  }
  const content = native.normalizeNative(out.doc || {});
  if (!content.blocks.length || !content.blocks.some((b) => b.kind === "heading") || !content.blocks.some((b) => b.kind === "text")) {
    /*
     * The provider has already been paid by this point. Validation failing, or
     * the commit losing a revision race, must not make that spend invisible:
     * Studio's usage row is the only meter on this feature, and a turn that
     * cost money with no row reads as a turn that never happened.
     */
    await logStudioUsage(req, { doc, hadBlocks, out: { ...out, timing: { rounds: 1, failed: true } } }).catch(() => {});
    const e = new Error("empty_native_document");
    e.aiStatus = 422;
    e.userMessage = "Materialın məzmunu tam qayıtmadı. Yenidən cəhd edin.";
    throw e;
  }
  const html = sanitizeDocHtml(native.nativeBlocksToHtml(content));
  if (!html) {
    await logStudioUsage(req, { doc, hadBlocks, out: { ...out, timing: { rounds: 1, failed: true } } }).catch(() => {});
    throw new Error("empty_native_html");
  }
  const sum = summarizeHtml(html);
  let saved;
  try {
    saved = await svc.commit(
    doc._id,
    doc.owner,
    {
      html,
      blocks: [],
      partCount: sum.blocks,
      /*
       * A print setting the ANSWER asked for. "Add page numbers and shorten the
       * text" reaches the engine whenever the local shortcut declines it, and
       * the text would be shortened while the page numbers were ignored — the
       * schema had nowhere to put them. Now it does, and it lands here.
       */
      ...(content.printOptions ? printOptions(content.printOptions) : {}),
      ...(content.title ? { title: content.title } : {}),
      ...(!doc.topic && content.title ? { topic: content.title } : {}),
      ...(content.audience && !doc.audience ? { audience: content.audience } : {}),
      status: "ready",
      aiMeta: {
        ...(doc.aiMeta && typeof doc.aiMeta === "object" ? doc.aiMeta : {}),
        provider: out.provider,
        model: out.cost?.model || nativeModel,
        engine: "platform-native",
        native: content,
        at: new Date(),
      },
    },
    baseRevision,
    {
      push: {
        messages: {
          role: "assistant",
          text: content.reply || (hadBlocks ? "Material platforma mühərriki ilə yeniləndi." : "Material platforma mühərriki ilə hazırlandı."),
          action: hadBlocks ? "edited" : "created",
          stats: sum,
          work: { engine: "platform-native", rounds: 1, renderer: "lessonDocHtml" },
          at: new Date(),
        },
      },
    }
    );
  } catch (err) {
    // Same reason as above: a lost revision race is not a free turn.
    await logStudioUsage(req, { doc, hadBlocks, out: { ...out, timing: { rounds: 1, failed: true } } }).catch(() => {});
    throw err;
  }
  await logStudioUsage(req, {
    doc: saved,
    hadBlocks,
    out: {
      ...out,
      timing: { planMs: 0, writeMs: Date.now() - started, rounds: 1, reads: parts.length ? 1 : 0, looked: false, fixes: 0 },
    },
  });
  chargeTurn(req, send);
  send("done", { doc: saved, summary: sum, provider: out.provider, engine: "platform-native" });
}

const streamMessage = asyncHandler(async (req, res) => {
  const doc = await mine(req, req.params.id);
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) throw httpError(400, "message_empty", "Nə yaratmaq istədiyinizi yazın.");
  if (text.length > 4000) throw httpError(422, "message_long", "Mesaj çox uzundur.");

  /*
   * The same click twice is one turn.
   *
   * The browser mints an id per send. A reconnect, a double-tap or a page that
   * re-sends on reload arrives here with the id of a turn this document has
   * already recorded, and is refused BEFORE anything is stored or charged. It
   * is not a cache — the answer is "already sent, reload", not a replay — but
   * it is the whole difference between a retry and a second bill.
   */
  const turnId = String((req.body && req.body.turnId) || "").slice(0, 80);
  if (turnId && (doc.messages || []).some((m) => m.role === "user" && m.turnId === turnId)) {
    throw httpError(409, "duplicate_turn", "Bu mesaj artıq göndərilib — səhifəni yeniləyin.");
  }

  /*
   * METERED — here, and not one line later.
   *
   * Which operation this is, and so what it costs, depends on whether the
   * document already has content: a first draft is priced as a generation, a
   * change as an edit. The document is loaded, so that is decidable now; the
   * SSE headers are not out yet, so a 402 still leaves as a proper JSON error
   * the client can read (it never could once the stream had started). Nothing
   * below this line runs unless the teacher can afford it, and the teacher's
   * message is not stored for a turn that was refused.
   */
  const hadBlocks = S.countParts(doc) > 0;
  req.aiCredit = meterFor(req, hadBlocks ? "ai.edit.material" : "ai.generate.material");

  // What this turn is ADDING, not everything the document holds — see stagedFiles.
  const sent = stagedFiles(doc);
  await svc.appendMessages(doc._id, doc.owner, {
    role: "user",
    text,
    at: new Date(),
    ...(turnId ? { turnId } : {}),
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
  // (hadBlocks was decided above, before the headers went out: the meter needed it.)
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
  /*
   * What the turn is doing, as it does it — sent live and kept on the message.
   *
   * The plan used to be shown once and then nothing moved until the document
   * landed. Each line here is a fact the loop reported (see aiDocDrivers
   * onEvent) turned into a sentence; the client shows the newest as the live
   * line and the whole list in the work log, and the list is stored with the
   * turn so "what did it do?" has an answer later. Capped so a runaway loop
   * cannot grow a message without bound.
   */
  const modelLabel = (S.DOC_MODELS.find((m) => m.id === model) || {}).label || model;
  const activity = [];
  const report = (kind, data) => {
    const text = activityText(kind, data || {});
    if (!text) return;
    const entry = { kind, text, at: Date.now() };
    if (activity.length < 80) activity.push(entry);
    send("activity", entry);
  };

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
    if (sending.length) report("files", { names: sending.map((f) => f.name) });

    /*
     * A document this engine did not write is edited by the engine that did.
     *
     * The native turn rebuilds the whole material from its own semantic source
     * (`aiMeta.native`). A document that predates it has no such source, so the
     * model was handed nothing to preserve, was told to write a new material,
     * and the commit replaced the teacher's existing work with it. Rather than
     * teach this engine to parse arbitrary old HTML, an existing document keeps
     * the engine that understands it; everything created from here on is native.
     */
    const nativeCanHandle = require("../helper/lessonDocNative").nativeCanHandle(doc, S.countParts);
    if (process.env.LESSON_DOC_NATIVE_ENGINE !== "false" && nativeCanHandle) {
      await runNativeMaterialTurn({
        req,
        doc,
        text,
        parts,
        files: sending,
        model,
        abortSignal: ac.signal,
        hadBlocks,
        baseRevision,
        send,
      });
      return;
    }

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
    report("plan", { model: modelLabel, editing: hadBlocks });
    // Where the minutes go, measured — see turn_done in logStudioUsage.
    const t0 = Date.now();
    let planMs = 0;
    let planCost = null;
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
        /*
         * A plan is a short structured answer — a title, a few headings, a
         * sentence per source — and it was thinking at full effort over the
         * whole attachment before the real work had started. Reading a file
         * is perception, not reasoning; the outline of a creation gets a
         * little thought because the writing pass is held to it, and the
         * steps of an edit get the least.
         */
        effort: hadBlocks ? "low" : "medium",
      });
      planMs = Date.now() - t0;
      planCost = p.cost || null;
      plan = S.normalizePlan(p.doc || {});
      report("planned", {
        steps: plan.sections.length,
        sources: plan.sources.length,
        readable: plan.sources.filter((x) => x && x.readable).length,
      });
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
          ).catch((e) => logStudioEvent("source_notes_not_saved", e));
        }
      }
      if (plan.sections.length) send("plan", { ...plan, editing: hadBlocks });
    } catch (e) {
      planMs = Date.now() - t0;
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
      logStudioEvent("plan_pass_failed", e);
      send("planning_degraded", { message: "Plan hazırlanmadı — birbaşa yazıram." });
      report("plan_failed");
    }

    // ---- phase 2: write it, reporting each block -----------------------------
    send("phase", { phase: "write", sections: plan?.sections?.length || 0 });
    report("write", { model: modelLabel, editing: hadBlocks });

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

    /*
     * Progress in the unit the running tool actually produces: finished parts
     * when the model is writing a document, finished changes when it is patching
     * one. Counting closed HTML tags in a patch would report a two-line edit as
     * a hundred-part rewrite, because every quoted fragment carries its own
     * markup — twice, once in `find` and once in `replace`.
     */
    const readBlocks = S.makeProgressStreamer();
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
    const t1 = Date.now();
    const out = await runTools({
      onEvent: report,
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
       * How hard to think, by what the turn actually is.
       *
       * Creating a material from a teacher's PDF is the hardest thing here and
       * gets everything the model has. An EDIT is not that: the document exists,
       * the request is usually local ("make the headings bigger", "add one more
       * example"), and the reasoning is mostly re-derivation of decisions already
       * made. Thinking bills at the OUTPUT rate, and on the turn that prompted
       * this change it was the larger half — 64,100 output tokens, $1.60 of
       * $2.94.
       *
       * "medium" rather than "low" deliberately: an edit can still be a hard
       * instruction against a long document, and the cheap setting is the one
       * that produces a plausible-looking wrong answer on those.
       */
      effort: hadBlocks ? EFFORT_EDIT : EFFORT_CREATE,
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
      validate: (name, input, draft) => {
        /*
         * A patch that does not apply, reported rather than guessed at.
         *
         * `edit_material` quotes the text to replace. A quote that matches
         * nothing means the model retyped from memory instead of copying, and
         * one that matches twice means the edit is ambiguous — applying it to
         * the first hit would be a coin toss with the teacher's document. Both
         * come back as a tool error naming the quote, which is exactly what the
         * model needs to retry with more surrounding context. Nothing here
         * rewrites the model's work; it states a fact about it.
         */
        if (name === "edit_material") {
          // Against the DRAFT when the turn has one: a patch in round three
          // applies to what round two left, not to the document the turn began
          // on — and on a creation, to the page the model just wrote.
          const r = applyEdits(draft || doc.html || "", input.edits);
          if (r.problems.length) return r.problems.join("\n");
          // The patched document still has to survive the same checks a written
          // one does — a valid patch can still produce a broken table.
          const patched = r.html;
          const findings = [checkTables(patched)];
          const lost = droppedStyles(patched, sanitizeDocHtml(patched));
          if (lost.length) {
            findings.push(
              `Bu style xüsusiyyətləri sənəddə saxlanmır və silindi: ${lost.join(", ")}. ` +
                "İcazə verilənlərlə eyni görünüşü ver və ya o detaldan imtina et."
            );
          }
          return findings.filter(Boolean).join("\n\n");
        }
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
          logStudioEvent("draft_render_failed", e);
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
      /*
       * A source, and only the pages of it that were asked for.
       *
       * Sending a whole twelve-page scan when three pages were wanted is the
       * single largest avoidable input on a turn — measured, pages 1-3 of a real
       * 9.95 MB bank come out at 1.18 MB. Unlike downscaling this costs no
       * fidelity at all: the same pages at the same resolution, fewer of them.
       *
       * The reply always states what was served and how many pages the file has.
       * A teacher's scan is numbered by its PRINTED pages — "с. 22-33" on a file
       * that holds twelve — so a model asking for page 22 is being reasonable and
       * needs the count rather than a refusal.
       */
      fetchSource: async (name, pages) => {
        const want = String(name || "").trim().toLowerCase();
        if (!want) return null;
        const all = doc.files || [];
        const hit =
          all.find((f) => String(f.name || "").toLowerCase() === want) ||
          all.find((f) => String(f.name || "").toLowerCase().includes(want)) ||
          all.find((f) => want.includes(String(f.name || "").toLowerCase()));
        if (!hit) return null;

        const F = require("../helper/lessonDocFiles");
        const got = await F.partForPages(hit, pages);
        const total = got.total ? ` Bu faylda cəmi ${got.total} səhifə var.` : "";

        if (!got.part) {
          return {
            name: hit.name,
            part: null,
            isError: true,
            note:
              `"${hit.name}" faylında istədiyin səhifə(lər) yoxdur.${total} ` +
              "Kitabın üzərində yazılan səhifə nömrəsi fayldaki sıra nömrəsi ilə üst-üstə " +
              "düşməyə bilər — sıra nömrəsi ilə yenidən istə.",
          };
        }
        const served = got.served
          ? `"${hit.name}" faylının ${got.served.from}-${got.served.to} səhifəsi aşağıda göndərildi.`
          : `"${hit.name}" bütövlükdə aşağıda göndərildi.`;
        return {
          name: hit.name,
          part: got.part,
          // For the report: which pages went, out of how many.
          served: got.served || null,
          total: got.total || 0,
          note:
            served +
            total +
            (got.outOfRange ? " (İstədiyin bəzi səhifələr faylda yoxdur — yalnız mövcud olanlar göndərildi.)" : ""),
        };
      },
      /*
       * The document a call produces, for the loop's render check.
       *
       * `write_material` carries the whole thing. `edit_material` carries only
       * the changed fragments, so the document it produces is this one with the
       * patch applied — computed here because the loop has no idea what the
       * current document is.
       */
      htmlOf: (c, draft) => {
        if (!c) return "";
        if (c.name === "write_material") return c.input?.html || "";
        if (c.name === "edit_material") {
          const r = applyEdits(draft || doc.html || "", c.input?.edits);
          return r.problems.length ? "" : r.html;
        }
        return "";
      },
    });
    /*
     * The plan pass is part of the turn's bill. It never was: the usage row
     * carried the tool loop alone, so a turn's recorded cost was short by a
     * full read of every attachment — on a first-read turn, the second most
     * expensive call it makes. The budget guard reads these rows; a cost it
     * cannot see is a cost it cannot cap.
     */
    out.cost = require("../helper/aiDocAdapters").sumCost(out.cost, planCost);
    out.timing = { planMs, writeMs: Date.now() - t1, ...(out.stats || {}) };

    /*
     * Two tools, one commit path.
     *
     * `edit_material` sends only what changed, so it is resolved HERE into the
     * same `{ input: { html, reply, title } }` shape `write_material` produces —
     * and everything downstream (sanitising, the summary, the revision commit,
     * the reply the teacher reads) stays one code path rather than two that can
     * drift. The patch is applied to the document this turn read, and the commit
     * below is fenced on that same revision, so a manual edit landing in between
     * loses to the CAS rather than being silently overwritten.
     *
     * A patch that no longer applies cannot get this far: `validate` reports it
     * to the model inside the loop. If one somehow does, it is treated as no
     * document at all rather than committing a half-applied edit.
     */
    const patch = out.calls.find((c) => c.name === "edit_material");
    let wrote = out.calls.find((c) => c.name === "write_material");
    let patchedCount = 0;
    if (out.document && out.document.html) {
      /*
       * What the loop ended on, not what its last round said.
       *
       * The final round may be a sentence — "the render matches" — or a patch
       * made against a draft two rounds old. The loop resolved every patch
       * against the draft as it went and hands back the document that
       * resulted; reading the last round's calls alone would drop a patch made
       * in an earlier round, or apply this one to the wrong base.
       */
      const by = out.document.call || {};
      patchedCount = by.name === "edit_material" ? (by.input?.edits || []).length : 0;
      wrote = {
        name: "write_material",
        input: { html: out.document.html, reply: by.input?.reply || "", title: by.input?.title || "" },
      };
    } else if (!wrote && patch) {
      const r = applyEdits(doc.html || "", patch.input?.edits);
      if (!r.problems.length) {
        patchedCount = r.applied;
        wrote = {
          name: "write_material",
          input: { html: r.html, reply: patch.input?.reply || "", title: patch.input?.title || "" },
        };
      } else {
        // A count, not the problem text: it quotes the document.
        logStudioEvent("patch_unapplicable", null, { problems: r.problems.length });
      }
    }
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
      // The turn ran to its end: it is charged. A question back is free.
      chargeTurn(req, send);
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
      // The turn ran to its end: it is charged. A question back is free.
      chargeTurn(req, send);
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
            ...(plan?.sources?.length || plan?.sections?.length || activity.length
              ? { work: { sources: plan?.sources || [], steps: plan?.sections || [], activity } }
              : {}),
            at: new Date(),
          },
        },
      }
    );

    await logStudioUsage(req, { doc: saved, out, hadBlocks });
    // The turn ran to its end: it is charged. A question back is free.
    chargeTurn(req, send);
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
          /*
           * What was streaming was the write_material call's INPUT — a JSON
           * object whose `html` is the document — so that is what a cut-off
           * looks like: valid JSON up to some point, then nothing. This used to
           * repair the snapshot into the old block shape and look for `blocks`,
           * which the model has not written for some time; every Stop fell
           * through to the bare note and the half-page the teacher watched
           * arrive was thrown away. A patch (edit_material) is not salvaged: a
           * list of replacements cut off mid-way gives no way to know which the
           * model had finished deciding on, and applying some is worse than none.
           */
          const repaired = require("../helper/aiDocument").repairTruncatedJson(lastSnapshot);
          const html = repaired && typeof repaired.html === "string" ? sanitizeDocHtml(repaired.html) : "";
          const sum = html ? summarizeHtml(html) : null;
          if (sum && sum.blocks > 0) {
            // Through the CAS, like every write: a stop is not a licence to
            // overwrite an edit the teacher made while this was running.
            await svc.commit(
              doc._id,
              doc.owner,
              {
                html,
                partCount: sum.blocks,
                blocks: [],
                status: "ready",
                aiMeta: { provider: e?.provider || "unknown", at: new Date() },
              },
              baseRevision,
              {
                push: {
                  messages: {
                    role: "assistant",
                    text: "Dayandırıldı — buraya qədər yazılan hissə saxlanıldı.",
                    action: "stopped",
                    stats: sum,
                    at: new Date(),
                  },
                },
              }
            );
            salvaged = true;
            // The teacher keeps this content, so the turn is charged — otherwise
            // Stop at 95% would be a free generation. A stop that kept nothing
            // costs nothing. There is no client left to tell; the badge catches
            // up on the next reload.
            if (req.aiCredit) req.aiCredit.usable();
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

  /*
   * Typed by its BYTES. `f.mimetype` is a header the browser fills in from the
   * filename, and it was the only gate: a file renamed to .pdf was a PDF as far
   * as this path could tell, and went to disk, to the model and to every later
   * viewer as one. The magic bytes are the one thing about an upload the client
   * cannot assert, so they decide, and the declared type is not consulted.
   */
  const typed = F.trustedType({ buffer: f.buffer, name: f.originalname });
  if (!typed.ok) {
    throw httpError(
      415,
      "bad_type",
      typed.reason === "mismatch"
        ? "Faylın məzmunu adındakı uzantı ilə uyğun gəlmir."
        : "Yalnız PDF, şəkil (PNG, JPG, WEBP, GIF), Word, PowerPoint və ya Excel faylı əlavə etmək olar."
    );
  }

  const files = doc.files || [];
  if (files.length >= F.MAX_FILES) {
    throw httpError(422, "too_many_files", `Ən çox ${F.MAX_FILES} fayl əlavə edə bilərsiniz.`);
  }
  const already = files.reduce((n, x) => n + (x.bytes || 0), 0);
  const overTotal = (bytes) => already + bytes > F.MAX_TOTAL_MB * 1024 * 1024;
  if (!typed.office && overTotal(f.size)) {
    throw httpError(413, "too_large", `Faylların ümumi həcmi ${F.MAX_TOTAL_MB}MB-dan çox ola bilməz.`);
  }

  let saved;
  if (typed.office) {
    /*
     * Word, PowerPoint, Excel: converted to PDF here, with the LibreOffice the
     * materials library already runs, and stored AS the PDF under the teacher's
     * own filename. No provider reads a .docx; every one of them reads a PDF.
     * Before the conversion the container gets the same deep structural check
     * the materials library applies — a ZIP is only a .docx once the right
     * member is inside it — and the whole thing runs through the conversion
     * queue, so ten uploads cannot start ten LibreOffice processes at once.
     */
    const os = require("os");
    const fsp = require("fs/promises");
    const path = require("path");
    const { validateUploadFile } = require("../utils/fileValidation");
    const { convertOfficeToPdf } = require("../utils/officeToPdf");
    const { enqueueConversion } = require("../utils/convertQueue");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "studio-office-"));
    try {
      const src = path.join(dir, `source.${typed.ext}`);
      await fsp.writeFile(src, f.buffer);
      const check = await validateUploadFile(src, `.${typed.ext}`);
      if (!check.ok) throw httpError(415, "bad_type", "Faylın məzmunu adındakı uzantı ilə uyğun gəlmir.");
      const pdfPath = await enqueueConversion(String(req.user._id), () => convertOfficeToPdf(src, dir));
      const pdf = await fsp.readFile(pdfPath);
      if (pdf.length > F.MAX_FILE_MB * 1024 * 1024 || overTotal(pdf.length)) {
        throw httpError(413, "too_large", `Çevrilmiş fayl ${F.MAX_FILE_MB}MB limitini keçir.`);
      }
      saved = await F.saveFile({ buffer: pdf, mime: "application/pdf", ext: "pdf", name: f.originalname });
    } catch (e) {
      if (isAppError(e)) throw e;
      // officeToPdf and convertQueue compose their own teacher-facing sentences;
      // anything else is an internal detail and gets the generic line.
      logStudioEvent("office_convert_failed", e, { ext: typed.ext });
      throw httpError(422, "convert_failed", "Fayl PDF-ə çevrilə bilmədi — faylı PDF kimi yükləyin.");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  } else {
    saved = await F.saveFile({ buffer: f.buffer, mime: typed.mime, ext: typed.ext, name: f.originalname });
  }

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
    /*
     * And the attachments. Deleting the row used to leave every attached file on
     * disk forever — someone's textbook pages, orphaned under a hash nothing
     * would ever look up again. Same ordering as removeFile: the row is already
     * gone, so the reference check naturally excludes it, and a file another
     * material still holds (content-addressed, so that happens) stays.
     */
    const F = require("../helper/lessonDocFiles");
    for (const f of doc.files || []) {
      // eslint-disable-next-line no-await-in-loop
      const stillUsed = await LessonDoc.exists({ "files.key": f.key });
      // eslint-disable-next-line no-await-in-loop
      await F.removeIfUnused(f.key, f.ext, Boolean(stillUsed));
    }
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

module.exports = { listDocs, createDoc, getDoc, streamMessage, addFile, getFile, removeFile, updateDoc, removeDoc, exportDoc, publicFailure, logStudioEvent };
// Exported for their tests: the narration a teacher reads while a turn runs,
// and the count that says how much of a document there is.
module.exports.activityText = activityText;
module.exports.summarizeHtml = summarizeHtml;
// Exported for the redaction test: the funnel that decides what a teacher is
// allowed to see is worth asserting on directly, not only through a live stream.
module.exports.publicFailure = publicFailure;
module.exports.assertSourcesReadable = assertSourcesReadable;
