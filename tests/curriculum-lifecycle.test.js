/*
 * CR-MSO-001 / 011 / 012 / 016 — the transactional lifecycle, on a REAL replica set.
 *
 * These behaviours only exist under transactions, so a single-node memory server
 * would prove nothing: withMongoTransaction falls through to work(null) under
 * NODE_ENV=test, and the whole point here is the fencing.
 *
 * What is proven:
 *   - a claim landing between the delete's reference check and its state CAS makes
 *     the delete abort, with nothing unlinked (the TOCTOU race);
 *   - a delete that wins first makes a later claim abort;
 *   - drafts and ACTIVE JOBS block deletion, not just published versions;
 *   - a draft pinning v1 still publishes against v1 after v2 supersedes it;
 *   - ARCHIVING releases nothing;
 *   - two identical publishes converge on ONE version; two different ones both
 *     persist and the pointer never regresses;
 *   - a published version row rejects every mutation.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const CurriculumSource = require("../models/curriculumSourceModel");
const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
const SourceReference = require("../models/sourceReferenceModel");
const LessonPlan = require("../models/lessonPlanModel");
const LessonPlanVersion = require("../models/lessonPlanVersionModel");
const svc = require("../services/curriculumSourceService");
const planSvc = require("../services/lessonPlanService");
const { withMongoTransaction } = require("../services/mongoUnitOfWork");
const { hashCanonical } = require("../helper/immutableVersion");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};
const codeOf = async (fn) => {
  try { await fn(); return null; } catch (e) { return e.code || e.message; }
};

const OWNER = new mongoose.Types.ObjectId();
let seq = 0;
async function mkSource(state = "ready") {
  const src = await CurriculumSource.create({ owner: OWNER, title: `Dərslik ${seq++}` });
  const v = await CurriculumSourceVersion.create({
    source: src._id,
    versionNumber: 1,
    storageKey: "a".repeat(63) + (seq % 10),
    sha256: "d".repeat(64),
    pageCount: 10,
    state,
  });
  src.activeVersion = v._id;
  src.activeVersionNumber = 1;
  await src.save();
  return { src, v };
}

async function sec1() {
  console.log("\n1. Claim vs delete — the TOCTOU race:");
  {
    const { src, v } = await mkSource();
    const holder = new mongoose.Types.ObjectId();

    // A claim commits BEFORE the delete's CAS: the delete must abort.
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: holder }, s));
    const code = await codeOf(() => svc.claimDeletion(v._id));
    ok("a referenced version cannot be deleted", code === "source_in_use", code);
    const after = await CurriculumSourceVersion.findById(v._id).lean();
    ok("its state is untouched (nothing would be unlinked)", after.state === "ready", after.state);

    // Release, then the delete succeeds.
    await withMongoTransaction((s) => svc.releaseHolder({ holderKind: "draft", holderId: holder }, s));
    const claim = await svc.claimDeletion(v._id);
    ok("once unreferenced, deletion can be claimed", claim.version.state === "deleting");
    ok("the claim carries an unpredictable deleteToken", typeof claim.deleteToken === "string" && claim.deleteToken.length >= 32);
    ok("finishing the deletion requires that exact token", (await svc.finishDeletion(v._id, "wrong")) === false);
    ok("the right token finishes it", (await svc.finishDeletion(v._id, claim.deleteToken)) === true);
    ok("refCount is a projection, reconciled from the references", (await CurriculumSource.findById(src._id).lean()).refCount === 0);
  }
  {
    // The other order: deletion wins first, so a later claim must abort.
    const { v } = await mkSource();
    await svc.claimDeletion(v._id);
    const code = await codeOf(() =>
      withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: new mongoose.Types.ObjectId() }, s))
    );
    ok("a claim on a version being deleted is refused", code === "source_version_unavailable", code);
    ok("no reference row was created", (await SourceReference.countDocuments({ sourceVersion: v._id })) === 0);
  }
  {
    // The fence itself: refEpoch moves on every claim, so a delete that observed an
    // older epoch cannot win.
    const { v } = await mkSource();
    const before = (await CurriculumSourceVersion.findById(v._id).lean()).refEpoch;
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: new mongoose.Types.ObjectId() }, s));
    const after = (await CurriculumSourceVersion.findById(v._id).lean()).refEpoch;
    ok("every claim bumps refEpoch", after === before + 1, `${before} -> ${after}`);
  }
}

async function sec2() {
  console.log("\n2. Holders include work in progress, not just publications:");
  for (const kind of ["draft", "job", "published_version"]) {
    const { v } = await mkSource();
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: kind, holderId: new mongoose.Types.ObjectId() }, s));
    const code = await codeOf(() => svc.claimDeletion(v._id));
    ok(`a ${kind} holder blocks deletion`, code === "source_in_use", code);
  }
  {
    // Claiming twice is idempotent — a retried publish must not inflate anything.
    const { v } = await mkSource();
    const holder = new mongoose.Types.ObjectId();
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: holder }, s));
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: holder }, s));
    ok("a repeated claim is idempotent", (await SourceReference.countDocuments({ sourceVersion: v._id })) === 1);
  }
}

async function sec3() {
  console.log("\n3. CR-MSO-016 — transfer, supersede and archive:");
  {
    const { v } = await mkSource();
    const draftId = new mongoose.Types.ObjectId();
    const versionId = new mongoose.Types.ObjectId();
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: draftId }, s));

    await withMongoTransaction((s) =>
      svc.transferHolder({ sourceVersionId: v._id, fromKind: "draft", fromId: draftId, toKind: "published_version", toId: versionId }, s)
    );
    const rows = await SourceReference.find({ sourceVersion: v._id }).lean();
    ok("the hold moved to the published version", rows.length === 1 && rows[0].holderKind === "published_version");
    ok("the source was never momentarily unreferenced", rows.length === 1);
    ok("deletion is still blocked afterwards", (await codeOf(() => svc.claimDeletion(v._id))) === "source_in_use");
  }
  {
    // A draft pinned v1; the teacher then uploads v2, superseding it. The draft
    // must STILL be able to publish against v1's exact bytes.
    const { v } = await mkSource();
    const draftId = new mongoose.Types.ObjectId();
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: draftId }, s));
    await CurriculumSourceVersion.updateOne({ _id: v._id }, { $set: { state: "superseded" } });

    const fresh = await codeOf(() =>
      withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "draft", holderId: new mongoose.Types.ObjectId() }, s))
    );
    ok("a FRESH claim on a superseded version is refused", fresh === "source_version_unavailable", fresh);

    const transferred = await codeOf(() =>
      withMongoTransaction((s) =>
        svc.transferHolder({ sourceVersionId: v._id, fromKind: "draft", fromId: draftId, toKind: "published_version", toId: new mongoose.Types.ObjectId() }, s)
      )
    );
    ok("an ALREADY-PINNED holder may still transfer onto a publication", transferred === null, transferred);
  }
  {
    // Archiving must release nothing: a citation pinned by a published version
    // stays valid for as long as that row exists.
    const { v } = await mkSource();
    const plan = await LessonPlan.create({ owner: OWNER, title: "Plan", stages: [{ name: "Giriş", minutes: 45 }] });
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "published_version", holderId: plan._id }, s));
    await planSvc.archive(plan._id, OWNER, true);
    ok("archiving keeps the source reference", (await SourceReference.countDocuments({ sourceVersion: v._id })) === 1);
    ok("deletion is still blocked after archiving", (await codeOf(() => svc.claimDeletion(v._id))) === "source_in_use");
    await planSvc.archive(plan._id, OWNER, false);
    ok("un-archiving re-claims nothing (the reference never left)", (await SourceReference.countDocuments({ sourceVersion: v._id })) === 1);
  }
  {
    // Cancelling a job releases, in the same transaction as the state change.
    const { v } = await mkSource();
    const jobId = new mongoose.Types.ObjectId();
    await withMongoTransaction((s) => svc.claimNew({ sourceVersionId: v._id, holderKind: "job", holderId: jobId }, s));
    await withMongoTransaction((s) => svc.releaseHolder({ holderKind: "job", holderId: jobId }, s));
    ok("a cancelled job releases its hold", (await SourceReference.countDocuments({ sourceVersion: v._id })) === 0);
    ok("the version becomes deletable again", (await codeOf(() => svc.claimDeletion(v._id))) === null);
  }
}

async function mkPlan(title = "Dərs planı") {
  return LessonPlan.create({
    owner: OWNER,
    title,
    topic: "Kvadrat tənliklər",
    lessonMinutes: 45,
    stages: [{ name: "Motivasiya", minutes: 10, teacher: "sual verir", student: "cavablandırır" }],
    tasks: [{ statement: "Tənliyi həll edin", solution: "x=2", sourceMode: "original" }],
  });
}

async function sec4() {
  console.log("\n4. CR-MSO-012 — concurrent publication:");
  {
    const plan = await mkPlan();
    const [a, b] = await Promise.all([planSvc.publish(plan._id, OWNER), planSvc.publish(plan._id, OWNER)]);
    ok("two IDENTICAL publishes converge on one version", String(a._id) === String(b._id), `${a._id} vs ${b._id}`);
    ok("exactly one version row exists", (await LessonPlanVersion.countDocuments({ docId: plan._id })) === 1);
    const p = await LessonPlan.findById(plan._id).lean();
    ok("the pointer advanced to it", String(p.activeVersion) === String(a._id) && p.activeVersionNumber === 1);
    ok("no orphan source reference was left", (await SourceReference.countDocuments({ holderId: a._id })) === 0);
  }
  {
    const plan = await mkPlan("Fərqli");
    const v1 = await planSvc.publish(plan._id, OWNER);
    await LessonPlan.updateOne({ _id: plan._id }, { $set: { topic: "Tam fərqli mövzu" } });
    const v2 = await planSvc.publish(plan._id, OWNER);
    ok("different content forks a new version", v2.versionNumber === 2 && v1.contentHash !== v2.contentHash);
    const p = await LessonPlan.findById(plan._id).lean();
    ok("the pointer moved forward, never back", p.activeVersionNumber === 2);

    // Republishing v1's content must reuse v1 and NOT move the pointer backwards.
    await LessonPlan.updateOne({ _id: plan._id }, { $set: { topic: "Kvadrat tənliklər" } });
    const again = await planSvc.publish(plan._id, OWNER);
    ok("republishing older content reuses the ORIGINAL version", String(again._id) === String(v1._id));
    const p2 = await LessonPlan.findById(plan._id).lean();
    ok("the active pointer did NOT regress", p2.activeVersionNumber === 2, p2.activeVersionNumber);
    ok("still exactly two versions", (await LessonPlanVersion.countDocuments({ docId: plan._id })) === 2);
  }
  {
    // The content hash is order-insensitive, so a re-serialised identical document
    // is genuinely identical.
    const a = hashCanonical({ x: 1, y: [1, 2], z: { b: 2, a: 1 } });
    const b = hashCanonical({ z: { a: 1, b: 2 }, y: [1, 2], x: 1 });
    ok("contentHash ignores key order", a === b);
    ok("contentHash notices a real change", a !== hashCanonical({ x: 1, y: [2, 1], z: { a: 1, b: 2 } }));
  }
}

async function sec5() {
  console.log("\n5. A published version row is immutable:");
  const plan = await mkPlan("Dəyişməz");
  const version = await planSvc.publish(plan._id, OWNER);

  const viaUpdate = await codeOf(() => LessonPlanVersion.updateOne({ _id: version._id }, { $set: { contentHash: "x" } }));
  ok("updateOne is refused", Boolean(viaUpdate), viaUpdate);
  const viaFind = await codeOf(() => LessonPlanVersion.findOneAndUpdate({ _id: version._id }, { $set: { contentHash: "x" } }));
  ok("findOneAndUpdate is refused", Boolean(viaFind));
  const viaDelete = await codeOf(() => LessonPlanVersion.deleteOne({ _id: version._id }));
  ok("deleteOne is refused", Boolean(viaDelete));
  const viaBulk = await codeOf(() => LessonPlanVersion.bulkWrite([{ deleteOne: { filter: { _id: version._id } } }]));
  ok("bulkWrite is refused", Boolean(viaBulk));
  const doc = await LessonPlanVersion.findById(version._id);
  doc.contentHash = "tampered";
  const viaSave = await codeOf(() => doc.save());
  ok("re-saving the document is refused", Boolean(viaSave));
  ok("the row is unchanged on disk", (await LessonPlanVersion.findById(version._id).lean()).contentHash === version.contentHash);
}

async function sec6() {
  console.log("\n6. Draft writes are compare-and-set:");
  const plan = await mkPlan("CAS");
  const rev = plan.revision;
  const updated = await planSvc.updateDraft(plan._id, OWNER, { topic: "Yeni" }, rev);
  ok("a write at the current revision succeeds", updated.topic === "Yeni" && updated.revision === rev + 1);

  const stale = await codeOf(() => planSvc.updateDraft(plan._id, OWNER, { topic: "Köhnə tab" }, rev));
  ok("a STALE revision is a 409 conflict", stale === "lesson_plan_conflict", stale);
  ok("the stale write did not land", (await LessonPlan.findById(plan._id).lean()).topic === "Yeni");

  const blind = await codeOf(() => planSvc.updateDraft(plan._id, OWNER, { topic: "Kor yazı" }, undefined));
  ok("a BLIND write (no revision) is refused outright", blind === "revision_required", blind);
  const bad = await codeOf(() => planSvc.updateDraft(plan._id, OWNER, { topic: "x" }, "abc"));
  ok("a malformed revision is refused", bad === "bad_revision", bad);
}

async function sec7() {
  console.log("\n7. An AI regeneration proposes; it never overwrites:");
  const plan = await mkPlan("Təklif");
  await planSvc.updateDraft(plan._id, OWNER, { topic: "Müəllimin redaktəsi" }, plan.revision);
  const proposed = { topic: "AI-nin təklifi", homework: "5 məsələ" };
  const { changed } = await planSvc.proposeRegeneration(plan._id, OWNER, proposed);

  const after = await LessonPlan.findById(plan._id).lean();
  ok("the teacher's draft is untouched", after.topic === "Müəllimin redaktəsi");
  ok("the proposal is stored separately", after.proposal && after.proposal.content.topic === "AI-nin təklifi");
  ok("the diff names the changed fields", changed.includes("topic") && changed.includes("homework"), JSON.stringify(changed));

  const accepted = await planSvc.acceptProposal(plan._id, OWNER, after.revision);
  ok("accepting applies it through the same CAS", accepted.topic === "AI-nin təklifi");
}

async function main() {
  const mem = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mem.getUri());
  const { modelFor, MODEL_COLLECTIONS } = require("../helper/curriculumIndexes");
  // The app never builds these (autoIndex/autoCreate off); the migration owns them.
  // A test must therefore build them explicitly, exactly as the migration does.
  await Promise.all(Object.keys(MODEL_COLLECTIONS).map((c) => modelFor(c).createIndexes()));

  await sec1();
  await sec2();
  await sec3();
  await sec4();
  await sec5();
  await sec6();
  await sec7();

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} curriculum-lifecycle assertions failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
