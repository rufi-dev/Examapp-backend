/*
 * The MSO generation worker.
 *
 * Everything around it existed and nothing called it, so "generate" created a job
 * that sat in the queue for ever. These are the properties that make the worker
 * safe to leave running unattended:
 *
 *   - the BLUEPRINT decides structure, not the model: a task that comes back with
 *     the wrong type, points or Bloom level is corrected, because the teacher
 *     approved that structure and a model must not be able to change it;
 *   - both variants come from ONE call, since "identical except the numbers"
 *     cannot be guaranteed across two;
 *   - a task that fails validation is KEPT and flagged, never dropped — a missing
 *     №7 is far harder for a teacher to notice than a №7 marked for review;
 *   - a citation is stripped unless the page really exists in the pinned file.
 *
 * The provider is stubbed: this is about what the worker does with an answer, not
 * about the model. Anything that touches Mongo runs on a real in-memory server.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const path = require("path");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

// Stub the provider BEFORE the worker pulls it in.
const aiDocPath = require.resolve("../helper/aiDocument");
let nextAnswer = { tasks: [] };
let calls = [];
require.cache[aiDocPath] = {
  id: aiDocPath,
  filename: aiDocPath,
  loaded: true,
  exports: {
    runDocument: async (args) => {
      calls.push(args);
      return { provider: "stub", doc: nextAnswer };
    },
  },
};

const MsoBlueprint = require("../models/msoBlueprintModel");
const MsoDocument = require("../models/msoDocumentModel");
const MsoGenerationJob = require("../models/msoGenerationJobModel");
const jobSvc = require("../services/msoJobService");
const worker = require("../jobs/msoWorker");
const { buildRows } = require("../config/msoPresets");

const OWNER = new mongoose.Types.ObjectId();
let seq = 0;

async function blueprint(rowCount = 4) {
  seq += 1;
  const rows = buildRows("az-mso-15").slice(0, rowCount);
  return MsoBlueprint.create({
    owner: OWNER,
    title: `Fəza fiqurları ${seq}`,
    grade: "5",
    subject: "Riyaziyyat",
    standard: "3.4",
    subStandards: ["3.4.1", "3.4.2", "3.4.3"],
    totalPoints: rows.reduce((s, r) => s + r.points, 0),
    rows,
  });
}

// What a well-behaved model returns for a batch.
const answerFor = (rows) => ({
  tasks: rows.flatMap((r) =>
    ["A", "B"].map((variant) => ({
      no: r.no,
      variant,
      statement: `${variant}: Kubun səth sahəsini tapın, tərəf ${variant === "A" ? 4 : 6} sm.`,
      choices: r.questionType === "closed4" ? ["96 sm²", "64 sm²", "24 sm²", "16 sm²"] : [],
      correctIndex: r.questionType === "closed4" ? 0 : -1,
      answer: variant === "A" ? "96 sm²" : "216 sm²",
      solution: "S = 6a²; S = 6·16 = 96 sm².",
      rubric: r.questionType === "closed4" ? "" : "Düstur 3 bal, hesablama 5 bal.",
      testedSkill: "Səth sahəsi düsturunun tətbiqi",
      subStandard: "3.4.1",
      criterion: "Səth sahəsini düzgün hesablayır",
      printedPageLabel: "",
      sourceTaskNo: "",
      sourceExcerpt: "",
    }))
  ),
});

async function main() {
  const mem = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mem.getUri());

  console.log("\n1. A claimed job is generated end to end:");
  {
    const bp = await blueprint(4);
    nextAnswer = answerFor(bp.rows);
    calls = [];
    await jobSvc.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-aaaa1111", sourceVersions: [] });
    const claimed = await jobSvc.claimJob("test-worker");
    ok("a queued job can be claimed", !!claimed);

    const r = await worker.runOne(claimed);
    ok("it finishes", r.done === true, JSON.stringify(r));

    const doc = await MsoDocument.findOne({ blueprint: bp._id }).lean();
    ok("a document was created", !!doc);
    ok("both variants of every row are persisted", doc.tasks.length === bp.rows.length * 2, doc.tasks.length);
    ok("A and B exist for row 1", ["A", "B"].every((v) => doc.tasks.some((t) => t.no === 1 && t.variant === v)));
    ok(
      "A and B differ in content",
      doc.tasks.find((t) => t.no === 1 && t.variant === "A").statement !==
        doc.tasks.find((t) => t.no === 1 && t.variant === "B").statement
    );

    // One call per batch, carrying BOTH variants — not one call per variant.
    ok("both variants came from one call", calls.length >= 1 && calls.length <= bp.rows.length);
    ok("the prompt states the locked structure", /struktur DƏYİŞDİRİLMƏZ/.test(calls[0].system + calls[0].prompt));

    const job2 = await MsoGenerationJob.findById(claimed._id).lean();
    ok("the job moves to review, not silently to done", job2.state === "needs_review", job2.state);
  }

  console.log("\n2. The blueprint decides structure, not the model:");
  {
    const bp = await blueprint(2);
    const rows = bp.rows;
    // A model that ignores the brief: wrong type, wrong points, wrong Bloom.
    nextAnswer = {
      tasks: rows.flatMap((r) =>
        ["A", "B"].map((variant) => ({
          ...answerFor([r]).tasks[0],
          variant,
          no: r.no,
        }))
      ),
    };
    nextAnswer.tasks.forEach((t) => {
      t.questionType = "extended";
      t.points = 999;
      t.bloom = "Yaratma";
    });
    await jobSvc.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-bbbb2222" });
    const claimed = await jobSvc.claimJob("test-worker");
    await worker.runOne(claimed);

    const doc = await MsoDocument.findOne({ blueprint: bp._id }).lean();
    const t1 = doc.tasks.find((t) => t.no === rows[0].no);
    ok("the type comes from the blueprint", t1.questionType === rows[0].questionType, t1.questionType);
    ok("the points come from the blueprint", t1.points === rows[0].points, t1.points);
    ok("the Bloom level comes from the blueprint", t1.bloom === rows[0].bloom, t1.bloom);
  }

  console.log("\n3. A bad task is flagged, never dropped:");
  {
    const bp = await blueprint(2);
    nextAnswer = answerFor(bp.rows);
    // Two correct answers is impossible to express, so break it the way a model
    // really does: a closed task with only two choices.
    nextAnswer.tasks[0].choices = ["96 sm²", "64 sm²"];
    await jobSvc.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-cccc3333" });
    const claimed = await jobSvc.claimJob("test-worker");
    await worker.runOne(claimed);

    const doc = await MsoDocument.findOne({ blueprint: bp._id }).lean();
    ok("the task is still there", doc.tasks.length === bp.rows.length * 2, doc.tasks.length);
    const bad = doc.tasks.find((t) => (t.choices || []).length === 2);
    ok("and it is marked for review", bad && bad.reviewStatus === "needs_teacher_review", bad && bad.reviewStatus);
    ok("with the reason recorded", bad && (bad.reviewNotes || []).length > 0, bad && bad.reviewNotes);
  }

  console.log("\n4. With no source, no citation is ever claimed:");
  {
    const bp = await blueprint(2);
    nextAnswer = answerFor(bp.rows);
    // A model that invents a page even though it was given no file.
    nextAnswer.tasks.forEach((t) => {
      t.printedPageLabel = "124";
      t.sourceTaskNo = "8";
      t.sourceExcerpt = "x".repeat(60);
    });
    await jobSvc.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-dddd4444" });
    const claimed = await jobSvc.claimJob("test-worker");
    await worker.runOne(claimed);

    const doc = await MsoDocument.findOne({ blueprint: bp._id }).lean();
    ok("no task carries evidence", doc.tasks.every((t) => !t.sourceEvidence));
    ok("and none claims to be from the textbook", doc.tasks.every((t) => t.sourceMode === "original"));
    ok("no page label survives anywhere", !JSON.stringify(doc.tasks).includes('"printedPageLabel":"124"'));
  }

  console.log("\n5. Resuming persists nothing twice:");
  {
    const bp = await blueprint(4);
    nextAnswer = answerFor(bp.rows);
    await jobSvc.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-eeee5555" });
    const first = await jobSvc.claimJob("test-worker");
    await worker.runOne(first);
    const before = (await MsoDocument.findOne({ blueprint: bp._id }).lean()).tasks.length;

    // Put it back in the queue and run it again, exactly as a retry would.
    await MsoGenerationJob.updateOne({ _id: first._id }, { $set: { state: "queued", nextAttemptAt: new Date(0) } });
    const again = await jobSvc.claimJob("test-worker-2");
    ok("it can be re-claimed", !!again);
    const r = await worker.runOne(again);
    const after = (await MsoDocument.findOne({ blueprint: bp._id }).lean()).tasks.length;
    ok("no task is duplicated", after === before, `${before} -> ${after}`);
    ok("and it reports done", r.done === true, JSON.stringify(r));
  }

  console.log("\n6. An empty answer fails the job instead of publishing nothing:");
  {
    const bp = await blueprint(2);
    nextAnswer = { tasks: [] };
    await jobSvc.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-ffff6666" });
    const claimed = await jobSvc.claimJob("test-worker");
    const r = await worker.runOne(claimed);
    ok("the run reports failure", r.failed === true, JSON.stringify(r));
    const j = await MsoGenerationJob.findById(claimed._id).lean();
    ok("the job is not marked ready for review", j.state !== "needs_review", j.state);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} mso-worker assertions failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
