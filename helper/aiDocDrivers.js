/*
 * One agentic loop, three providers.
 *
 * WHY A DRIVER AND NOT THREE LOOPS. The studio turn stopped being a request some
 * time ago: the model calls a tool, a finding goes back as a tool result, it asks
 * to read a source and the file is handed over mid-conversation, it is shown a
 * render of its own draft and the column arithmetic behind it, and it corrects
 * itself. That sequence is the product. Writing it once per provider means three
 * copies of the only thing that decides whether a document comes out right, and
 * this file's own header already records what happened the last time six nearly
 * identical provider functions were allowed to drift apart.
 *
 * So the loop lives here and knows nothing about any provider. An adapter answers
 * four questions — how do I send this, what tool calls came back, what did it say,
 * and how do I hand a result (and a picture) back — and the loop does the rest.
 * A provider that cannot answer them cannot run a studio turn, which is a real
 * limit and better stated in code than discovered by a teacher.
 *
 * WHAT EACH PROVIDER COSTS THE TEACHER, stated because the picker offers them:
 *   - Claude streams the document as it is written, so the live progress in the
 *     chat is real work finished. The other two do not stream tool arguments in a
 *     shape this can count, so a turn on them reports the phase and no count.
 *   - All three read PDFs and images, take tools, and can be shown a render.
 */

const DEFAULT_MAX_FIXES = 2;
const DEFAULT_MAX_READS = 4;

/*
 * The conversation, once, for any provider.
 *
 * Bounds are deliberate and separate: a model that cannot satisfy a check on the
 * second attempt will not satisfy it on the sixth, and the teacher is waiting;
 * fetching a source is work the model asked for rather than a failed attempt, so
 * it has its own budget; looking at the draft happens once, because the first look
 * is where a merged row becomes obvious and the second says nothing new.
 */
async function runToolLoop(adapter, opts) {
  const { validate, fetchSource, look, gridOf, signal, needsDocument } = opts;

  /*
   * Which call produced a document, and what its HTML is.
   *
   * There are now two ways to produce one: `write_material` carries the whole
   * document in its input, and `edit_material` carries only the parts that
   * changed — the caller has to apply those to the document it holds, which is
   * why this is a callback rather than a field read. Everything downstream (the
   * render check, the grid map, the "it described the work instead of doing it"
   * guards) only cares THAT a document was produced and what it says, so asking
   * once here keeps all of them working for both tools.
   */
  const htmlOf =
    typeof opts.htmlOf === "function"
      ? opts.htmlOf
      : (c) => (c && c.name === "write_material" ? c.input?.html || "" : "");

  /*
   * The document as it stands INSIDE this turn.
   *
   * A turn is several rounds, and the document changes between them: the
   * model writes it, is shown a render, patches it, is told about a short
   * table row, patches it again. Every round used to resolve a patch against
   * the document the turn STARTED from, so a second patch in one turn was
   * applied to the original and the first patch was thrown away — and on a
   * creation there was no document at all to patch, so the only fix the model
   * could make after seeing its own draft was to type the whole thing again.
   * Measured on one real creation: 64,100 output tokens for a 145-part
   * document, most of it the same document re-emitted, and twenty-one minutes.
   *
   * The draft is what the last producing call left behind, and every callback
   * that resolves a patch gets it, so `edit_material` applies to what the
   * model just wrote.
   */
  let draft = "";
  let producedBy = null;

  const documentCall = (list) => {
    for (const c of list) {
      const html = htmlOf(c, draft);
      if (html) return { call: c, html };
    }
    return null;
  };

  // A turn that produced a document is not a turn that only fetched or fiddled
  // with settings, whichever tool it used to do it.
  const madeDocument = (list) => list.some((c) => c.name === "write_material" || c.name === "edit_material");
  const MAX_FIXES = opts.maxFixes || DEFAULT_MAX_FIXES;
  const MAX_READS = opts.maxReads || DEFAULT_MAX_READS;

  let reads = 0;
  let looked = false;
  // How the turn went, for the timing line the controller logs: rounds are
  // provider calls, fixes are rounds spent answering a finding.
  let rounds = 0;
  let fixes = 0;
  /*
   * Progress, as it happens. The caller turns these into sentences for the
   * teacher: which source is being read, that the draft is being rendered,
   * that a finding went back. A turn used to be a single "Yazıram…" for its
   * whole length; nothing said which of its several rounds it was in.
   */
  const emit =
    typeof opts.onEvent === "function"
      ? (k, d) => {
          try {
            opts.onEvent(k, d || {});
          } catch {
            /* reporting must never break the turn it reports on */
          }
        }
      : () => {};
  // Why the next round is happening, named for the report.
  let reason = "start";
  let usage = { input_tokens: 0, output_tokens: 0 };
  /*
   * The turn's spend, as a breakdown rather than a scalar.
   *
   * This started at 0, which made the Claude adapter's `cost + computeCost(...)`
   * concatenate an object onto a number and produce "0[object Object]". Null is
   * the honest starting value — nothing has been spent and nothing has been
   * measured — and the adapters build the breakdown the usage row reads.
   */
  let cost = null;
  let unresolved = [];
  let calls = [];
  let said = "";
  /*
   * The last round that actually produced something.
   *
   * A round after the first is a REPLY to a finding or to a render, and "the
   * draft is fine as it is" can be answered with silence — Gemini in particular
   * returns a STOP with no parts, having spent its thinking budget agreeing with
   * itself. Treating that as an empty turn threw away a document the model had
   * already written and finished, and the teacher got "AI cavabı oxunmadı" over a
   * material that existed. Silence after work means the work stands.
   */
  let lastWork = null;

  const history = adapter.start(opts);

  for (let attempt = 0; ; attempt += 1) {
    if (rounds > 0) emit("round", { n: rounds + 1, reason });
    // eslint-disable-next-line no-await-in-loop
    const turn = await adapter.send(history, opts);
    rounds += 1;
    for (const c of turn.calls || []) {
      if (c.name === "read_source") emit("read", { name: String(c.input?.name || ""), pages: c.input?.pages });
      else if (c.name === "write_material" || c.name === "edit_material") emit("wrote", { tool: c.name, call: c });
      else if (c.name === "set_print_options") emit("settings");
      else if (c.name === "ask_teacher") emit("asked");
    }

    usage = {
      input_tokens: (usage.input_tokens || 0) + (turn.usage?.input_tokens || 0),
      output_tokens: (usage.output_tokens || 0) + (turn.usage?.output_tokens || 0),
    };
    cost = adapter.addCost ? adapter.addCost(cost, turn) : cost;
    calls = turn.calls || [];
    said = turn.said || "";
    if (calls.length) lastWork = { calls, said };
    else if (lastWork) {
      /*
       * A round with no tool call, after a round that had one. The model is
       * answering the render or the finding in words — "the design looks right,
       * the material is ready" — rather than repeating a document it is happy
       * with. Silence and agreement are the same thing here, and both were read
       * as an empty turn, so a finished document was discarded and the teacher
       * got "AI cavabı oxunmadı" over a material that existed.
       *
       * The last real work stands, and whatever it said last is kept as its word
       * on the turn.
       */
      calls = lastWork.calls;
      said = said || lastWork.said;
      emit("agree");
      break;
    }

    if (signal?.aborted) throw adapter.cancelled();

    /*
     * It described the work instead of doing it.
     *
     * Asked to copy a PDF, the model replied "Faylı originala uyğun olaraq,
     * bütün mətn, düstur və həndəsi fiqurlarla birlikdə köçürdüm" — I have copied
     * the file with all its text, formulas and figures — and called no tool. The
     * turn ended `done`, the teacher was told it was finished, and the document
     * had nothing in it. That is the complaint that started this whole thread, in
     * its purest form: it acts like it did the work.
     *
     * Nothing here judges the prose. The document is empty, a document was asked
     * for, and no tool was called — three facts — so it is told to use the tool.
     * Only when there is no earlier work to fall back on: prose AFTER a write is
     * agreement, and that is handled above.
     */
    if (needsDocument && !calls.length && said && !lastWork && attempt < MAX_FIXES) {
      adapter.nudge(
        history,
        turn,
        "Sən sənədi yazdığını dedin, amma heç bir alət çağırmadın — material hələ boşdur. " +
          "Mətni write_material aləti ilə göndər: cavab yazmaq sənədi yaratmır."
      );
      emit("nudge");
      reason = "after_nudge";
      // eslint-disable-next-line no-continue
      continue;
    }

    /*
     * A source the model asked for, handed over as the real file. A description
     * of a page is what produced a copy of our own preview instead of a copy of
     * the teacher's PDF.
     */
    const asked = calls.filter((c) => c.name === "read_source");
    const wants = typeof fetchSource === "function" && reads < MAX_READS ? asked : [];

    /*
     * It asked for a file and cannot be given one — the read budget is spent, or
     * this caller serves no sources at all. Saying so is the difference between
     * a turn it can finish and a turn that ends holding a request nobody
     * answered: read_source is not a document, so the turn would return no
     * document and the teacher would be told the answer could not be read, over
     * a request that was perfectly reasonable.
     */
    if (!wants.length && asked.length && !madeDocument(calls)) {
      adapter.reply(
        history,
        turn,
        asked.map((c) => ({
          call: c,
          isError: true,
          text: "Fayl indi göndərilə bilmir. Sənədi əlindəki məlumatla yaz və nəyin çatmadığını cavabında bildir.",
        })),
        {}
      );
      emit("refused_read");
      reason = "after_refused";
      // Not a failed attempt on its part: it asked a fair question and we said no.
      attempt -= 1;
      // eslint-disable-next-line no-continue
      continue;
    }

    if (wants.length) {
      const results = [];
      const files = [];
      for (const c of wants) {
        reads += 1;
        /*
         * The page request goes with the name. A turn that needs three pages of
         * a twelve-page test bank should be sent three, and the fetcher reports
         * back WHICH pages it served and how many the file has — the request and
         * the answer are allowed to differ (a scan numbered by its printed pages
         * does not line up with its file positions), and the model can only
         * correct for that if it is told.
         */
        // eslint-disable-next-line no-await-in-loop
        const found = await fetchSource(String(c.input?.name || ""), c.input?.pages);
        results.push({
          call: c,
          // A fetch can succeed at finding the file and still fail to answer the
          // request — "page 22 of a 12-page file". That has to reach the model as
          // an error, or it reads the note as a delivery and carries on without
          // the pages it asked for.
          isError: !found || found.isError === true,
          text: found
            ? found.note || `"${found.name}" aşağıda göndərildi.`
            : `"${c.input?.name}" tapılmadı. Mövcud faylların adlarını promptdakı siyahıdan götür.`,
        });
        if (found && found.part) files.push(found.part);
        emit("served", {
          name: found ? found.name : String(c.input?.name || ""),
          ok: Boolean(found && found.part && found.isError !== true),
          from: found?.served?.from,
          to: found?.served?.to,
          total: found?.total || 0,
        });
      }
      adapter.reply(history, turn, results, { parts: files });
      reason = "after_read";
      attempt -= 1; // a fetch is not a failed attempt
      // eslint-disable-next-line no-continue
      continue;
    }

    /*
     * The teacher asked for a material and got a colour.
     *
     * Given a PDF to copy, the model looked at its orange border, called
     * set_print_options, and replied that it had kept the accent colour and the
     * page numbers. It had answered the DESIGN half of "copy this exactly" and
     * never written a word of the document — and because a settings call is a
     * legitimate answer to some turns, nothing objected. The teacher was left
     * with an empty material and a note about colours.
     *
     * This is not a judgement about what they meant: the document is empty and
     * the turn produced no document. Both halves are facts, so the model is told
     * and gets to finish the job.
     */
    if (
      needsDocument &&
      !madeDocument(calls) &&
      calls.some((c) => c.name === "set_print_options") &&
      attempt < MAX_FIXES
    ) {
      adapter.reply(
        history,
        turn,
        calls
          .filter((c) => c.name === "set_print_options")
          .map((c) => ({
            call: c,
            isError: true,
            text:
              "Çap parametrləri saxlanıldı, amma sənədin MƏZMUNU hələ yazılmayıb — " +
              "material boşdur. write_material ilə mətni yaz.",
          })),
        {}
      );
      emit("settings_only");
      reason = "after_settings";
      // eslint-disable-next-line no-continue
      continue;
    }

    // Findings: things that can be shown to be wrong without seeing the source.
    const faults = typeof validate === "function"
      ? calls.map((c) => ({ call: c, why: validate(c.name, c.input || {}, draft) })).filter((f) => f.why)
      : [];

    // Whichever tool produced it, and the document it produced.
    const produced = documentCall(calls);
    const wrote = produced ? produced.call : null;
    /*
     * A document with a finding against it still becomes the draft.
     *
     * It is tempting to refuse a draft that failed a check, and it is wrong:
     * the model's next move is a PATCH to exactly that document, so refusing
     * it leaves the patch applying to the previous draft — on a creation, to
     * nothing at all — and the fix silently misses. The finding is not a
     * reason to forget what was written; it is a reason to change it. A patch
     * that cannot be applied never gets here: `htmlOf` returns nothing for it,
     * so `produced` is null and the draft stands.
     */
    if (produced) {
      draft = produced.html;
      producedBy = produced.call;
    }

    /*
     * The picture and the arithmetic. Every other check here is arithmetic on the
     * markup, and arithmetic cannot see that the ruling is wrong; the map is what
     * the picture cannot say, because a cell holding a long sentence stretches its
     * column until a one-column cell looks like a block spanning seven.
     */
    if (!faults.length && typeof look === "function" && !looked && wrote && attempt < MAX_FIXES) {
      // eslint-disable-next-line no-await-in-loop
      // The document as it will STAND, not as the call spelled it: for a patch
      // edit the call carries only the changed fragments, and reviewing those
      // would be reviewing the diff instead of the page.
      emit("look");
      const seen = await look(produced.html);
      const shots = seen?.shots || [];
      const pages = seen?.pages || 0;
      const map = typeof gridOf === "function" ? gridOf(produced.html) : "";
      /*
       * A page count alone is worth a round even with no pictures. Asked for two
       * pages a model writes what feels like two and produces five, because it
       * has never been told how long a page is; this is the only place that can
       * tell it, and the answer comes from Chromium paginating the real
       * stylesheet rather than from a guess about words per page.
       */
      if (shots.length || pages) {
        looked = true;
        emit("looked", { pages, bands: shots.length });
        reason = "after_look";
        adapter.reply(
          history,
          turn,
          [{ call: wrote, isError: false, text: lookNote(shots.length, map, pages) }],
          { images: shots }
        );
        attempt -= 1; // verifying is not failing
        // eslint-disable-next-line no-continue
        continue;
      }
    }

    if (!faults.length || attempt >= MAX_FIXES) {
      /*
       * Out of attempts with something still wrong. The document is kept — a
       * timetable with one short row is worth more to the teacher than a failed
       * turn — and the model, which has had the finding, says in its own reply
       * what it could not resolve.
       */
      unresolved = faults.map((f) => f.why);
      if (unresolved.length) console.error("[LESSON DOC] unresolved after retries:", unresolved[0].split("\n")[0]);
      if (unresolved.length) emit("unresolved", { n: unresolved.length });
      break;
    }

    fixes += 1;
    emit("finding", { n: faults.length });
    reason = "after_finding";
    /*
     * A finding against a document that exists in this turn is answered with a
     * patch, not a rewrite. Said here, at the moment it matters, because the
     * model that just wrote 20,000 tokens of HTML does not know the loop can
     * apply a find/replace to them — it only knows the document it was asked
     * to change does not exist yet.
     */
    const patchHint = draft ? `\n\n${PATCH_HINT}` : "";
    adapter.reply(
      history,
      turn,
      faults.map((f) => ({ call: f.call, isError: true, text: f.why + (f.call === wrote ? patchHint : "") })),
      {}
    );
  }

  return {
    calls,
    said,
    cost,
    usage,
    unresolved,
    provider: adapter.name,
    /*
     * The document the turn ended on, whichever call produced it and however
     * many patches followed. The caller commits THIS; reading the last round's
     * calls alone would miss a patch made in an earlier round, or resolve a
     * later patch against the wrong base.
     */
    document: draft ? { html: draft, call: producedBy } : null,
    stats: { rounds, reads, looked, fixes },
  };
}

/*
 * How to answer a finding about the draft: change the part, not the page.
 *
 * `edit_material` was written for a document that already exists on disk, and
 * its description says so — which left a model in the middle of a creation with
 * no way to fix one row except by re-sending every row. It applies to the draft
 * of this turn too, and this is how the model is told.
 */
const PATCH_HINT =
  "Düzəlişi edit_material ilə göndər — yalnız dəyişən parçaları (find/replace); " +
  "o, indi yazdığın mətnə tətbiq olunur. Bütün sənədi write_material ilə yenidən yazma — " +
  "yalnız sənədin quruluşu bütövlükdə dəyişməlidirsə.";

const lookNote = (bands, map, pages) =>
  [
    pages
      ? `Bu sənəd PDF-də ${pages} səhifə çıxır (Chromium ilə real ölçülüb, təxmin deyil). ` +
        "Müəllim müəyyən sayda səhifə istəyibsə və bu uyğun gəlmirsə, mətni ona görə " +
        "qısalt və ya uzat, sonra write_material-ı yenidən çağır."
      : "",
    bands ? `Yazdığın sənədin görüntüsü aşağıdadır (${bands} hissə, yuxarıdan aşağıya).` : "",
    bands ? "Mənbə ilə müqayisə et: xətlər, sütunların düzülüşü, boş xanalar, rənglər, hizalama." : "",
    map ? `\nXANALARIN SÜTUN NÖMRƏLƏRİ (hesablanmış, təxmin deyil):\n${map}` : "",
    "\nDiqqət: geniş görünən xana geniş olmaya bilər — mətn uzun olduğu üçün sütun uzanır.",
    "Blokların hansı sütunlarda olduğunu yuxarıdakı siyahıdan yoxla və başlıq sətrindəki",
    "tarixlərlə tutuşdur.",
    /*
     * This used to end "if everything matches, send the same HTML again" — an
     * instruction to re-emit the entire document, at output price and output
     * speed, to say nothing had changed. Agreement is a sentence. A difference
     * is a patch. The whole page is rewritten only when its structure is wrong.
     */
    "\nFərq varsa: yalnız dəyişən parçaları edit_material ilə düzəlt (find/replace) —",
    "o, indi yazdığın mətnə tətbiq olunur. Sənədin QURULUŞU bütövlükdə səhvdirsə,",
    "yalnız onda write_material ilə yenidən yaz.",
    "Hər şey uyğundursa HEÇ BİR alət çağırma — bir cümlə ilə uyğun olduğunu yaz.",
    "Eyni HTML-i yenidən göndərmə.",
  ]
    .filter(Boolean)
    .join("\n");

module.exports = { runToolLoop, lookNote, PATCH_HINT, DEFAULT_MAX_FIXES, DEFAULT_MAX_READS };
