/*
 * CR-MSO-003 / CR-MSO-004 — the resumable, fenced, exactly-once-settled MSO job.
 *
 * FENCING. Every job write carries the worker's `leaseToken` AND `attemptNo` in the
 * FILTER, not just in the update. `leaseOwner` alone is not enough: a worker whose
 * lease expired can wake mid-provider-call and write after another worker has
 * claimed the job. With the token in the filter that write matches nothing.
 *
 * BATCH DURABILITY. Task persistence and the batch checkpoint happen in ONE
 * transaction, closing the window where a crash leaves tasks written but the batch
 * still "pending". Task identity is deterministic — `${jobId}:${pairId}:${variant}`
 * — so even if the checkpoint were lost, resume reconciles what is already
 * persisted BEFORE any provider retry and regenerates nothing accepted.
 *
 * SETTLEMENT. aiCreditService.recoverStaleReservations() releases expired
 * reservations, which must NOT decide a document job's outcome:
 *     output persisted -> crash before commit -> generic recovery forgives the charge.
 * So each batch carries a durable settlement intent moved in the same transaction
 * that persists it, and recovery here inspects BUSINESS OUTCOME: usable output =>
 * commit, none => release.
 */
const crypto = require("crypto");
const MsoGenerationJob = require("../models/msoGenerationJobModel");
const MsoDocument = require("../models/msoDocumentModel");
const MsoBlueprint = require("../models/msoBlueprintModel");
const { withMongoTransaction, sessionOpt } = require("./mongoUnitOfWork");
const { httpError } = require("../utils/appError");
const validators = require("../helper/msoValidators");

const LEASE_MS = Number(process.env.MSO_LEASE_MS) || 120_000;
const MAX_ATTEMPTS = Number(process.env.MSO_MAX_ATTEMPTS) || 8;
const ROWS_PER_BATCH = Number(process.env.MSO_ROWS_PER_BATCH) || 4;
const CLIENT_REQ_ID_RE = /^[A-Za-z0-9._:-]{8,200}$/;

const taskId = (jobId, pairId, variant) => `${jobId}:${pairId}:${variant}`;
const backoffMs = (attempts) => Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));

// Bounded batches: 40 complete tasks will not fit reliably in one response.
function planBatches(jobId, rows) {
  const batches = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_BATCH) {
    batches.push({
      index: batches.length,
      pairIds: rows.slice(i, i + ROWS_PER_BATCH).map((r) => `p${r.no}`),
      state: "pending",
      acceptedTaskIds: [],
      settlement: "none",
      attempts: 0,
    });
  }
  return batches;
}

/*
 * Start (or RESUME) a job. The unique {owner, clientReqId} index means a retry or
 * a reconnect with the same key finds the same job rather than starting a second
 * one — and therefore never generates or charges twice.
 */
async function startJob({ owner, blueprintId, clientReqId, sourceVersions = [] }) {
  if (!CLIENT_REQ_ID_RE.test(String(clientReqId || ""))) {
    throw httpError(400, "invalid_client_request_id", "İstək açarı düzgün deyil.");
  }
  const existing = await MsoGenerationJob.findOne({ owner, clientReqId });
  if (existing) return existing; // idempotent replay

  const bp = await MsoBlueprint.findById(blueprintId).lean();
  if (!bp) throw httpError(404, "blueprint_missing", "Blueprint tapılmadı.");
  const readiness = validators.readyToGenerate(bp);
  if (!readiness.ok) {
    throw httpError(422, "blueprint_incomplete", "Blueprint tamamlanmayıb.", {
      undecidedRows: readiness.undecidedRows,
    });
  }

  const id = crypto.randomBytes(12).toString("hex");
  try {
    return await MsoGenerationJob.create({
      owner,
      blueprint: blueprintId,
      clientReqId,
      sourceVersions,
      state: "queued",
      batches: planBatches(id, bp.rows),
    });
  } catch (e) {
    // Two requests raced on the same key: the loser reads the winner's job.
    if (e && e.code === 11000) return MsoGenerationJob.findOne({ owner, clientReqId });
    throw e;
  }
}

/*
 * Claim a runnable job with an UNPREDICTABLE lease token. Mirrors
 * jobs/outboxWorker.js and the attempt finalizer: runnable, not dead-lettered,
 * lease free or expired.
 */
async function claimJob(workerId, { now = new Date(), jobId = null } = {}) {
  const leaseToken = crypto.randomBytes(16).toString("hex");
  return MsoGenerationJob.findOneAndUpdate(
    {
      // `jobId` narrows the claim to one job (a targeted retry, or a test); without
      // it a worker takes whatever is runnable, which is the normal drain path.
      ...(jobId ? { _id: jobId } : {}),
      state: { $in: ["queued", "running"] },
      deadLetterAt: null,
      nextAttemptAt: { $lte: now },
      $or: [{ leaseUntil: null }, { leaseUntil: { $lt: now } }],
    },
    {
      $set: { state: "running", leaseOwner: workerId, leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS) },
      $inc: { attemptNo: 1, attempts: 1 },
    },
    { new: true, sort: { nextAttemptAt: 1 } }
  );
}

// Extend the lease DURING a long provider call. Fenced: a worker that already lost
// the lease cannot extend it back.
async function renewLease(job, now = new Date()) {
  const renewed = await MsoGenerationJob.findOneAndUpdate(
    { _id: job._id, leaseToken: job.leaseToken, attemptNo: job.attemptNo },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { new: true }
  );
  return Boolean(renewed);
}

const holdsLease = async (job) =>
  Boolean(await MsoGenerationJob.exists({ _id: job._id, leaseToken: job.leaseToken, attemptNo: job.attemptNo }));

/*
 * Persist one batch's tasks AND its checkpoint in a single transaction.
 * Every write is fenced on (leaseToken, attemptNo), so a stale worker cannot
 * persist anything at all.
 */
async function persistBatch(job, batchIndex, tasks, { reservationId = "" } = {}) {
  return withMongoTransaction(async (session) => {
    const fenced = await MsoGenerationJob.findOne({
      _id: job._id,
      leaseToken: job.leaseToken,
      attemptNo: job.attemptNo,
    }).session(session || null);
    if (!fenced) {
      const e = new Error("lease_lost");
      e.code = "lease_lost";
      throw e;
    }

    let doc = fenced.document ? await MsoDocument.findById(fenced.document).session(session || null) : null;
    if (!doc) {
      const bp = await MsoBlueprint.findById(fenced.blueprint).lean().session(session || null);
      const created = await MsoDocument.create(
        [{
          owner: fenced.owner,
          blueprint: fenced.blueprint,
          title: bp ? bp.title : "MSO",
          sourceVersions: fenced.sourceVersions || [],
          tasks: [],
        }],
        sessionOpt(session)
      );
      doc = created[0];
    }

    // Deterministic identity makes re-persisting the same task a no-op instead of
    // a duplicate, which is what lets a resume be safe even without the checkpoint.
    const have = new Set((doc.tasks || []).map((t) => taskId(job._id, t.pairId, t.variant)));
    const accepted = [];
    for (const t of tasks) {
      const id = taskId(job._id, t.pairId, t.variant);
      if (have.has(id)) { accepted.push(id); continue; }
      doc.tasks.push(t);
      have.add(id);
      accepted.push(id);
    }
    await doc.save({ session: session || undefined });

    await MsoGenerationJob.updateOne(
      { _id: job._id, leaseToken: job.leaseToken, attemptNo: job.attemptNo },
      {
        $set: {
          document: doc._id,
          [`batches.${batchIndex}.state`]: "accepted",
          [`batches.${batchIndex}.acceptedTaskIds`]: accepted,
          // Output is durable; the charge is now OWED. The generic reaper must not
          // decide this — only the document recovery worker below may.
          [`batches.${batchIndex}.settlement`]: reservationId ? "commit_owed" : "none",
          [`batches.${batchIndex}.reservationId`]: reservationId,
        },
      },
      sessionOpt(session)
    );
    return { document: doc._id, accepted };
  });
}

/*
 * What still needs generating. Reconciles against tasks ACTUALLY PERSISTED, not
 * merely against the checkpoint, so a crash between the two costs nothing.
 */
async function pendingWork(job) {
  const doc = job.document ? await MsoDocument.findById(job.document).lean() : null;
  const persisted = new Set((doc ? doc.tasks || [] : []).map((t) => taskId(job._id, t.pairId, t.variant)));
  return (job.batches || [])
    .map((b, index) => ({ index, batch: b }))
    .filter(({ batch }) => {
      const wanted = (batch.pairIds || []).flatMap((p) => ["A", "B"].map((v) => taskId(job._id, p, v)));
      return !wanted.every((id) => persisted.has(id));
    });
}

async function failJob(job, failureCode) {
  const attempts = (job.attempts || 0) + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  await MsoGenerationJob.updateOne(
    { _id: job._id, leaseToken: job.leaseToken, attemptNo: job.attemptNo },
    {
      $set: {
        state: dead ? "failed" : "queued",
        failureCode: String(failureCode || "unknown"),
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
        ...(dead ? { deadLetterAt: new Date() } : {}),
      },
    }
  );
  return { dead, attempts };
}

async function finishJob(job) {
  const remaining = await pendingWork(job);
  const done = remaining.length === 0;
  await MsoGenerationJob.updateOne(
    { _id: job._id, leaseToken: job.leaseToken, attemptNo: job.attemptNo },
    {
      $set: {
        state: done ? "needs_review" : "queued",
        leaseOwner: null,
        leaseToken: null,
        leaseUntil: null,
        ...(done ? { finishedAt: new Date() } : { nextAttemptAt: new Date() }),
      },
    }
  );
  return done;
}

/*
 * Document-specific settlement recovery.
 *
 * Generic stale-reservation recovery may only RELEASE, and only when no usable
 * output was persisted. Here we look at the business outcome instead: a batch whose
 * tasks are durable is COMMITTED even though the process died before committing.
 */
async function recoverSettlements({ commit, release } = {}) {
  const jobs = await MsoGenerationJob.find({ "batches.settlement": { $in: ["commit_owed", "reserved"] } });
  let committed = 0;
  let released = 0;
  for (const job of jobs) {
    const doc = job.document ? await MsoDocument.findById(job.document).lean() : null;
    const persisted = new Set((doc ? doc.tasks || [] : []).map((t) => taskId(job._id, t.pairId, t.variant)));
    for (const [i, b] of (job.batches || []).entries()) {
      if (!["commit_owed", "reserved"].includes(b.settlement)) continue;
      const wanted = (b.pairIds || []).flatMap((p) => ["A", "B"].map((v) => taskId(job._id, p, v)));
      const usable = wanted.some((id) => persisted.has(id));
      if (usable) {
        if (typeof commit === "function") await commit(b.reservationId, job);
        await MsoGenerationJob.updateOne({ _id: job._id }, { $set: { [`batches.${i}.settlement`]: "settled" } });
        committed += 1;
      } else if (b.settlement === "reserved") {
        if (typeof release === "function") await release(b.reservationId, job);
        await MsoGenerationJob.updateOne({ _id: job._id }, { $set: { [`batches.${i}.settlement`]: "released" } });
        released += 1;
      }
    }
  }
  return { committed, released };
}

async function cancelJob(jobId, ownerId) {
  const { releaseHolder } = require("./curriculumSourceService");
  return withMongoTransaction(async (session) => {
    const job = await MsoGenerationJob.findOne({ _id: jobId, owner: ownerId }).session(session || null);
    if (!job) throw httpError(404, "job_missing", "İş tapılmadı.");
    // Cancelling ends the hold, in the same transaction as the state change.
    await releaseHolder({ holderKind: "job", holderId: job._id }, session);
    await MsoGenerationJob.updateOne(
      { _id: job._id },
      { $set: { state: "cancelled", leaseOwner: null, leaseToken: null, leaseUntil: null, finishedAt: new Date() } },
      sessionOpt(session)
    );
    return true;
  });
}

module.exports = {
  LEASE_MS,
  MAX_ATTEMPTS,
  ROWS_PER_BATCH,
  CLIENT_REQ_ID_RE,
  taskId,
  planBatches,
  startJob,
  claimJob,
  renewLease,
  holdsLease,
  persistBatch,
  pendingWork,
  failJob,
  finishJob,
  recoverSettlements,
  cancelJob,
  backoffMs,
};
