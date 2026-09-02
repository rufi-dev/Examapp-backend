/*
 * The MSO generation worker — the piece that was missing.
 *
 * Everything around it already existed: the blueprint, the validators, the fenced
 * job with its batches, the immutable publish and the four renderings. Nothing
 * called them. Pressing "generate" created a job that returned 202 and then sat in
 * the queue for ever, because `claimJob` was invoked only from tests.
 *
 * What this does, per claimed job:
 *   - take the batches that are not yet fully persisted (`pendingWork`);
 *   - for each, ask ONE provider call for BOTH variants of those rows, because
 *     "identical except the numbers" cannot be guaranteed across two calls;
 *   - drop the blueprint's locked fields onto the result rather than trusting the
 *     model to have echoed them, then run the validators;
 *   - persist inside the job's transaction, which is what makes a crash between
 *     the write and the checkpoint harmless.
 *
 * The lease is renewed around every provider call. A worker that loses its lease
 * cannot write at all — persistBatch fences on (leaseToken, attemptNo) — so a
 * stale worker waking up mid-generation corrupts nothing.
 */
const MsoBlueprint = require("../models/msoBlueprintModel");
const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
const job = require("../services/msoJobService");
const validators = require("../helper/msoValidators");
const { buildMsoPrompt } = require("../helper/msoPrompt");
const { MSO_BATCH_SCHEMA, MSO_BATCH_GEMINI_SCHEMA } = require("../helper/msoSchema");
const storage = require("../helper/curriculumStorage");
const evidence = require("../helper/curriculumEvidence");
const geometry = require("../helper/curriculumGeometry");

const WORKER_ID = `mso-${process.pid}`;
const MAX_SOURCE_MB = Number(process.env.MSO_MAX_SOURCE_MB) || 20;

const clean = (v) => String(v == null ? "" : v).trim();

/*
 * The blueprint row is the authority for structure. The model is TOLD these values
 * and asked only for content, but a model that echoes them wrongly must not be able
 * to change the paper the teacher approved — so they are overwritten, not merged.
 */
function shapeTask(raw, row, pairId) {
  const closed = row.questionType === "closed4";
  const choices = Array.isArray(raw.choices) ? raw.choices.map(clean).filter(Boolean) : [];
  return {
    no: row.no,
    variant: raw.variant === "B" ? "B" : "A",
    pairId,
    questionType: row.questionType,
    points: Number(row.points),
    bloom: row.bloom,
    subStandard: clean(raw.subStandard) || row.subStandard || "",
    criterion: clean(raw.criterion) || row.criterion || "",
    testedSkill: clean(raw.testedSkill) || row.testedSkill || "",
    difficulty: row.difficulty || "",
    statement: clean(raw.statement),
    choices: closed ? choices : undefined,
    correctIndex: closed && Number.isInteger(raw.correctIndex) ? raw.correctIndex : undefined,
    answer: clean(raw.answer),
    solution: clean(raw.solution),
    rubric: closed ? "" : clean(raw.rubric),
    sourceMode: "verbatim",
  };
}

// Read the pinned chapter once per job, not once per batch.
async function loadSource(sourceVersions) {
  if (!(sourceVersions || []).length) return null;
  const v = await CurriculumSourceVersion.findById(sourceVersions[0]);
  if (!v || !["ready", "superseded"].includes(v.state)) return null;
  if (v.bytes > MAX_SOURCE_MB * 1024 * 1024) return null;
  const file = storage.pathForKey(v.storageKey, v.ext);
  const intact = await storage.verifyBytes(v.storageKey, v.ext, v.sha256);
  if (!intact.ok) return null;
  const fsp = require("fs").promises;
  return {
    version: v,
    file,
    part: { mime: "application/pdf", data: (await fsp.readFile(file)).toString("base64"), isPdf: true },
  };
}

/*
 * Verify every page a task claims against the file it was generated from. A page
 * the book does not have loses its citation and the task is flagged — the same
 * rule the lesson plan follows, for the same reason: a wrong "səh. 124" printed on
 * an exam is worse than no reference at all.
 */
async function verifyCitations(tasks, source, cache) {
  if (!source) {
    for (const t of tasks) {
      t.sourceEvidence = undefined;
      t.sourceMode = "original";
    }
    return;
  }
  for (const t of tasks) {
    const label = clean(t._pageLabel);
    if (!label) {
      t.sourceEvidence = undefined;
      t.sourceMode = "original";
      continue;
    }
    const idx = geometry.fileIndexForLabel(source.version.pageMap, label, source.version.pageCount);
    if (idx < 0) {
      t.sourceEvidence = undefined;
      t.sourceMode = "original";
      t.reviewStatus = "needs_teacher_review";
      continue;
    }
    if (!cache.has(idx)) cache.set(idx, await evidence.pdfPageText(source.file, idx));
    const m = evidence.matchExcerpt(cache.get(idx), { excerpt: t._excerpt, sourceTaskNo: t._taskNo });
    t.sourceEvidence = {
      source: source.version.source,
      sourceVersion: source.version._id,
      sourceHash: source.version.sha256,
      filePageIndex: idx,
      printedPageLabel: label,
      sourceTaskNo: clean(t._taskNo),
      excerpt: clean(t._excerpt),
      verifyStatus: m.status,
      verifyReason: m.reason || "",
    };
    if (m.status !== evidence.VERIFY_STATUS.MACHINE_MATCHED) t.reviewStatus = "needs_teacher_review";
  }
  for (const t of tasks) {
    delete t._pageLabel;
    delete t._excerpt;
    delete t._taskNo;
  }
}

async function runBatch(claimed, bp, batch, source, cache) {
  const rows = (bp.rows || []).filter((r) => (batch.pairIds || []).includes(`p${r.no}`));
  if (!rows.length) return [];

  const { system, prompt } = buildMsoPrompt({ blueprint: bp, rows, hasSource: Boolean(source) });
  const { runDocument } = require("../helper/aiDocument");

  await job.renewLease(claimed);
  const out = await runDocument({
    system,
    prompt,
    parts: source ? [source.part] : [],
    schema: MSO_BATCH_SCHEMA,
    geminiSchema: MSO_BATCH_GEMINI_SCHEMA,
  });
  await job.renewLease(claimed);

  const byNo = new Map(rows.map((r) => [Number(r.no), r]));
  const tasks = [];
  for (const raw of (out.doc && out.doc.tasks) || []) {
    const row = byNo.get(Number(raw.no));
    if (!row) continue; // a row this batch did not ask for
    const t = shapeTask(raw, row, `p${row.no}`);
    t._pageLabel = raw.printedPageLabel;
    t._excerpt = raw.sourceExcerpt;
    t._taskNo = raw.sourceTaskNo;
    tasks.push(t);
  }

  await verifyCitations(tasks, source, cache);

  // Structure is checked BEFORE anything is persisted. A task that fails is kept
  // and flagged rather than dropped: a missing №7 is harder for a teacher to
  // notice than a №7 marked "yoxlayın".
  for (const t of tasks) {
    const problems = validators.validateTask(t, byNo.get(t.no));
    if (problems.length) {
      t.reviewStatus = "needs_teacher_review";
      t.reviewNotes = problems.map((p) => p.code);
    }
  }
  return tasks;
}

async function runOne(claimed) {
  const bp = await MsoBlueprint.findById(claimed.blueprint).lean();
  if (!bp) {
    await job.failJob(claimed, "blueprint_missing");
    return { failed: true };
  }
  const source = await loadSource(claimed.sourceVersions);
  const cache = new Map();
  const pending = await job.pendingWork(claimed);

  let persisted = 0;
  for (const { index, batch } of pending) {
    let tasks;
    try {
      tasks = await runBatch(claimed, bp, batch, source, cache);
    } catch (e) {
      // One bad batch must not lose the batches already durable.
      console.error("[MSO] batch", index, "failed:", e.message);
      await job.failJob(claimed, e.code === "lease_lost" ? "lease_lost" : "provider_failed");
      return { failed: true, persisted };
    }
    if (!tasks.length) {
      await job.failJob(claimed, "empty_generation");
      return { failed: true, persisted };
    }
    try {
      await job.persistBatch(claimed, index, tasks);
      persisted += tasks.length;
    } catch (e) {
      if (e.code === "lease_lost") return { failed: true, persisted };
      throw e;
    }
  }
  /*
   * Re-read before finishing. persistBatch creates the MsoDocument and stamps it on
   * the job IN THE DATABASE; the claimed object in memory still has document:null,
   * and finishJob asks pendingWork — which looks the tasks up THROUGH that pointer.
   * Finishing on the stale copy therefore found no tasks at all and put a fully
   * generated job straight back on the queue to be generated again.
   */
  const MsoGenerationJob = require("../models/msoGenerationJobModel");
  const fresh = (await MsoGenerationJob.findById(claimed._id)) || claimed;
  const done = await job.finishJob(fresh);
  return { done, persisted };
}

// One job per tick: generation is slow and a second concurrent job would compete
// for the same provider budget for no gain.
async function runMsoJobs() {
  const claimed = await job.claimJob(WORKER_ID);
  if (!claimed) return { idle: true };
  const r = await runOne(claimed);
  console.log(`[MSO] job ${claimed._id}: ${JSON.stringify(r)}`);
  return r;
}

module.exports = { runMsoJobs, runOne, runBatch, shapeTask, loadSource };
