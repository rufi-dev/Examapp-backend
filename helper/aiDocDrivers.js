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
  const { validate, fetchSource, look, gridOf, signal } = opts;
  const MAX_FIXES = opts.maxFixes || DEFAULT_MAX_FIXES;
  const MAX_READS = opts.maxReads || DEFAULT_MAX_READS;

  let reads = 0;
  let looked = false;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let cost = 0;
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
    // eslint-disable-next-line no-await-in-loop
    const turn = await adapter.send(history, opts);

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
      break;
    }

    if (signal?.aborted) throw adapter.cancelled();

    /*
     * A source the model asked for, handed over as the real file. A description
     * of a page is what produced a copy of our own preview instead of a copy of
     * the teacher's PDF.
     */
    const wants = typeof fetchSource === "function" && reads < MAX_READS
      ? calls.filter((c) => c.name === "read_source")
      : [];

    if (wants.length) {
      const results = [];
      const files = [];
      for (const c of wants) {
        reads += 1;
        // eslint-disable-next-line no-await-in-loop
        const found = await fetchSource(String(c.input?.name || ""));
        results.push({
          call: c,
          isError: !found,
          text: found
            ? `"${found.name}" aşağıda göndərildi.`
            : `"${c.input?.name}" tapılmadı. Mövcud faylların adlarını promptdakı siyahıdan götür.`,
        });
        if (found) files.push(found.part);
      }
      adapter.reply(history, turn, results, { parts: files });
      attempt -= 1; // a fetch is not a failed attempt
      // eslint-disable-next-line no-continue
      continue;
    }

    // Findings: things that can be shown to be wrong without seeing the source.
    const faults = typeof validate === "function"
      ? calls.map((c) => ({ call: c, why: validate(c.name, c.input || {}) })).filter((f) => f.why)
      : [];

    const wrote = calls.find((c) => c.name === "write_material");

    /*
     * The picture and the arithmetic. Every other check here is arithmetic on the
     * markup, and arithmetic cannot see that the ruling is wrong; the map is what
     * the picture cannot say, because a cell holding a long sentence stretches its
     * column until a one-column cell looks like a block spanning seven.
     */
    if (!faults.length && typeof look === "function" && !looked && wrote && attempt < MAX_FIXES) {
      // eslint-disable-next-line no-await-in-loop
      const seen = await look(wrote.input?.html || "");
      const shots = seen?.shots || [];
      const pages = seen?.pages || 0;
      const map = typeof gridOf === "function" ? gridOf(wrote.input?.html || "") : "";
      /*
       * A page count alone is worth a round even with no pictures. Asked for two
       * pages a model writes what feels like two and produces five, because it
       * has never been told how long a page is; this is the only place that can
       * tell it, and the answer comes from Chromium paginating the real
       * stylesheet rather than from a guess about words per page.
       */
      if (shots.length || pages) {
        looked = true;
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
      break;
    }

    adapter.reply(history, turn, faults.map((f) => ({ call: f.call, isError: true, text: f.why })), {});
  }

  return { calls, said, cost, usage, unresolved, provider: adapter.name };
}

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
    "\nFərq varsa write_material-ı düzəldilmiş HTML ilə yenidən çağır.",
    "Hər şey uyğundursa eyni HTML-i yenidən göndər.",
  ]
    .filter(Boolean)
    .join("\n");

module.exports = { runToolLoop, lookNote, DEFAULT_MAX_FIXES, DEFAULT_MAX_READS };
