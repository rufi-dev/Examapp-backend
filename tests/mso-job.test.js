/*
 * CR-MSO-003 / CR-MSO-004 — job durability, lease fencing and exactly-once credit.
 *
 * Replica set, because batch persistence and its checkpoint share a transaction and
 * that is the whole point: a crash between them must cost nothing.
 *
 * The two failures this file exists to prevent:
 *   1. a worker whose lease expired waking mid-provider-call and writing over the
 *      worker that replaced it (leaseOwner alone cannot stop this);
 *   2. output persisted -> crash before commit -> generic stale-reservation
 *      recovery RELEASES the reservation and the charge is silently forgiven.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const MsoBlueprint = require("../models/msoBlueprintModel");
const MsoDocument = require("../models/msoDocumentModel");
const MsoGenerationJob = require("../models/msoGenerationJobModel");
const job = require("../services/msoJobService");
const { buildRows } = require("../config/msoPresets");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};
const codeOf = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.code || e.message; }
};
// A PLAIN lease handle. Spreading a Mongoose document copies its internals, not
// its fields, so the fenced writes would silently lose _id/leaseToken.
const lease = (jobId, leaseToken, attemptNo) => ({ _id: jobId, leaseToken, attemptNo });

const OWNER = new mongoose.Types.ObjectId();
let seq = 0;

async function mkBlueprint({ preset = "az-mso-15" } = {}) {
  const rows = buildRows(preset);
  const complete = rows.every((r) => Number.isFinite(Number(r.points)));
  return MsoBlueprint.create({
    owner: OWNER,
    title: `MSO ${seq++}`,
    presetId: preset,
    rowCount: rows.length,
    rows,
    totalPoints: complete ? rows.reduce((s, r) => s + Number(r.points), 0) : undefined,
  });
}
const ROWS = 15;

const mkTasks = (pairIds) =>
  pairIds.flatMap((pid) =>
    ["A", "B"].map((variant) => ({
      no: Number(pid.slice(1)),
      variant,
      pairId: pid,
      questionType: "closed4",
      points: 5,
      statement: `Sual ${pid}${variant}`,
      choices: ["a", "b", "c", "d"],
      correctIndex: 0,
      reviewStatus: "accepted",
    }))
  );

async function sec1() {
  console.log("\n1. Idempotent start — a retry resumes, it never duplicates:");
  const bp = await mkBlueprint();
  const a = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-abc-123456" });
  const b = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-abc-123456" });
  ok("the same clientReqId returns the SAME job", String(a._id) === String(b._id));
  ok("only one job row exists", (await MsoGenerationJob.countDocuments({ owner: OWNER, clientReqId: "req-abc-123456" })) === 1);
  ok("work is split into bounded batches", (a.batches || []).length === Math.ceil(ROWS / job.ROWS_PER_BATCH), (a.batches || []).length);
  ok("every row is covered exactly once", (() => {
    const all = (a.batches || []).flatMap((x) => x.pairIds);
    return all.length === ROWS && new Set(all).size === ROWS;
  })());

  const bad = await codeOf(() => job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "short" }));
  ok("a malformed idempotency key is refused", bad === "invalid_client_request_id", bad);

  const incomplete = await mkBlueprint({ preset: "az-mso-20" });
  const refused = await codeOf(() => job.startJob({ owner: OWNER, blueprintId: incomplete._id, clientReqId: "req-incomplete-1" }));
  ok("a blueprint with undecided rows refuses to start", refused === "blueprint_incomplete", refused);
}

async function sec2() {
  console.log("\n2. Lease fencing — a stale worker cannot write at all:");
  const bp = await mkBlueprint();
  const j = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-lease-000001" });

  const w1 = await job.claimJob("worker-1", { jobId: j._id });
  ok("a worker can claim a queued job", Boolean(w1) && w1.state === "running");
  ok("the claim carries an unpredictable lease token", typeof w1.leaseToken === "string" && w1.leaseToken.length >= 32);

  const w2 = await job.claimJob("worker-2", { jobId: j._id });
  ok("a second worker cannot claim it while the lease holds", w2 === null);

  // Expire the lease, then let another worker take over.
  await MsoGenerationJob.updateOne({ _id: j._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
  const w3 = await job.claimJob("worker-3", { jobId: j._id });
  ok("an EXPIRED lease can be taken over", Boolean(w3) && w3.leaseOwner === "worker-3");
  ok("the takeover bumped attemptNo", w3.attemptNo === w1.attemptNo + 1, `${w1.attemptNo} -> ${w3.attemptNo}`);

  ok("the new worker holds the lease", (await job.holdsLease(w3)) === true);
  ok("the OLD worker no longer holds it", (await job.holdsLease(w1)) === false);
  ok("the old worker cannot renew it back", (await job.renewLease(w1)) === false);
  ok("the current worker can renew", (await job.renewLease(w3)) === true);

  // The decisive assertion: the stale worker's write matches nothing.
  const stale = await codeOf(() => job.persistBatch(w1, 0, mkTasks(["p1"])));
  ok("a stale worker's persistBatch is REFUSED", stale === "lease_lost", stale);
  const doc = await MsoDocument.findOne({ blueprint: bp._id }).lean();
  ok("and it wrote nothing", !doc || (doc.tasks || []).length === 0);
}

async function sec3() {
  console.log("\n3. Batch persistence + checkpoint are one transaction:");
  const bp = await mkBlueprint();
  const j = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-batch-000001" });
  const w = await job.claimJob("worker-b", { jobId: j._id });

  const batch0 = w.batches[0];
  const r = await job.persistBatch(w, 0, mkTasks(batch0.pairIds), { reservationId: "res-1" });
  ok("the batch persisted its tasks", r.accepted.length === batch0.pairIds.length * 2);

  const after = await MsoGenerationJob.findById(j._id).lean();
  ok("the checkpoint moved to accepted", after.batches[0].state === "accepted");
  ok("the settlement intent became commit_owed", after.batches[0].settlement === "commit_owed", after.batches[0].settlement);
  ok("the document was created and linked", Boolean(after.document));

  // Re-persisting the same tasks is a no-op: identity is deterministic.
  const again = await job.persistBatch(lease(j._id, w.leaseToken, after.attemptNo), 0, mkTasks(batch0.pairIds), { reservationId: "res-1" });
  const doc = await MsoDocument.findById(after.document).lean();
  ok("re-persisting the same batch adds no duplicates", doc.tasks.length === batch0.pairIds.length * 2, doc.tasks.length);
  ok("and reports the same accepted ids", again.accepted.length === r.accepted.length);

  // Resume reconciles against PERSISTED TASKS, not merely the checkpoint.
  await MsoGenerationJob.updateOne({ _id: j._id }, { $set: { "batches.0.state": "pending", "batches.0.acceptedTaskIds": [] } });
  const reread = await MsoGenerationJob.findById(j._id);
  const pending = await job.pendingWork(reread);
  ok("a LOST checkpoint does not schedule already-persisted work", !pending.some((p) => p.index === 0), JSON.stringify(pending.map((p) => p.index)));
  ok("the remaining batches are still pending", pending.length === (reread.batches || []).length - 1);
}

async function sec4() {
  console.log("\n4. CR-MSO-004 — settlement follows BUSINESS OUTCOME:");
  {
    // Output persisted, then the process died before committing the charge. The
    // generic reaper would release it; the document worker must COMMIT it.
    const bp = await mkBlueprint();
    const j = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-settle-00001" });
    const w = await job.claimJob("worker-s1", { jobId: j._id });
    await job.persistBatch(w, 0, mkTasks(w.batches[0].pairIds), { reservationId: "res-commit" });

    const committed = [];
    const released = [];
    const out = await job.recoverSettlements({
      commit: async (id) => committed.push(id),
      release: async (id) => released.push(id),
    });
    ok("usable output => the charge is COMMITTED, not forgiven", committed.includes("res-commit"), JSON.stringify(committed));
    ok("nothing was released", released.length === 0);
    ok("the intent advanced to settled", out.committed >= 1);
    const after = await MsoGenerationJob.findById(j._id).lean();
    ok("the batch is marked settled", after.batches[0].settlement === "settled", after.batches[0].settlement);

    // Running recovery twice must not charge twice.
    const second = await job.recoverSettlements({ commit: async (id) => committed.push(id), release: async () => {} });
    ok("recovery is idempotent — no double charge", second.committed === 0 && committed.filter((x) => x === "res-commit").length === 1);
  }
  {
    // Reserved, but nothing usable was ever persisted: this one is released.
    const bp = await mkBlueprint();
    const j = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-settle-00002" });
    await MsoGenerationJob.updateOne(
      { _id: j._id },
      { $set: { "batches.0.settlement": "reserved", "batches.0.reservationId": "res-release" } }
    );
    const released = [];
    const committed = [];
    await job.recoverSettlements({ commit: async (id) => committed.push(id), release: async (id) => released.push(id) });
    ok("no usable output => the reservation is RELEASED", released.includes("res-release"), JSON.stringify(released));
    ok("and nothing was committed", committed.length === 0);
  }
}

async function sec5() {
  console.log("\n5. Failure, backoff and dead-lettering:");
  const bp = await mkBlueprint();
  const j = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-fail-0000001" });
  let w = await job.claimJob("worker-f", { jobId: j._id });
  const first = await job.failJob(w, "provider_timeout");
  ok("a failure requeues rather than dying immediately", first.dead === false);
  let state = await MsoGenerationJob.findById(j._id).lean();
  ok("the lease is cleared on failure", state.leaseOwner === null && state.leaseToken === null);
  ok("the failure code is recorded", state.failureCode === "provider_timeout");
  ok("retry is scheduled in the future (backoff)", state.nextAttemptAt > new Date());
  ok("backoff grows with attempts", job.backoffMs(1) < job.backoffMs(4) && job.backoffMs(99) <= 60000);

  await MsoGenerationJob.updateOne({ _id: j._id }, { $set: { attempts: job.MAX_ATTEMPTS - 1, nextAttemptAt: new Date(0) } });
  w = await job.claimJob("worker-f2", { jobId: j._id });
  const last = await job.failJob(w, "provider_timeout");
  ok("it dead-letters at the attempt cap", last.dead === true);
  state = await MsoGenerationJob.findById(j._id).lean();
  ok("a dead-lettered job is retained for inspection", state.state === "failed" && Boolean(state.deadLetterAt));
  ok("and is no longer claimable", (await job.claimJob("worker-f3", { jobId: j._id })) === null);
}

async function sec6() {
  console.log("\n6. Finishing and cancelling:");
  const bp = await mkBlueprint();
  const j = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-finish-00001" });
  let w = await job.claimJob("worker-x", { jobId: j._id });
  for (const [i, b] of w.batches.entries()) {
    const cur = await MsoGenerationJob.findById(j._id).lean();
    await job.persistBatch(lease(j._id, cur.leaseToken, cur.attemptNo), i, mkTasks(b.pairIds), { reservationId: `res-${i}` });
  }
  const fresh = await MsoGenerationJob.findById(j._id).lean();
  const done = await job.finishJob(lease(j._id, fresh.leaseToken, fresh.attemptNo));
  ok("a job with every batch persisted finishes", done === true);
  const state = await MsoGenerationJob.findById(j._id).lean();
  ok("it lands in needs_review, not done — a teacher must review", state.state === "needs_review", state.state);
  const doc = await MsoDocument.findById(state.document).lean();
  ok("both variants of every question were produced", doc.tasks.length === ROWS * 2, doc.tasks.length);

  const j2 = await job.startJob({ owner: OWNER, blueprintId: bp._id, clientReqId: "req-cancel-00001" });
  await job.cancelJob(j2._id, OWNER);
  const cancelled = await MsoGenerationJob.findById(j2._id).lean();
  ok("cancelling clears the lease and marks it cancelled", cancelled.state === "cancelled" && cancelled.leaseToken === null);
  ok("a cancelled job is not claimable", (await MsoGenerationJob.findOne({ _id: j2._id, state: { $in: ["queued", "running"] } })) === null);
}

async function main() {
  const mem = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mem.getUri());
  const { modelFor, MODEL_COLLECTIONS } = require("../helper/curriculumIndexes");
  await Promise.all(Object.keys(MODEL_COLLECTIONS).map((c) => modelFor(c).createIndexes()));

  await sec1();
  await sec2();
  await sec3();
  await sec4();
  await sec5();
  await sec6();

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} mso-job assertions failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
