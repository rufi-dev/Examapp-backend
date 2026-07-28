/*
 * CR-125 — referral qualification job, CAS transitions, claim caps, durable
 * binding recovery, absolute-share honesty. Real in-memory Mongo.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-refq";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const TeacherReferral = require("../models/teacherReferralModel");
const svc = require("../services/teacherReferralService");
const { REFERRAL_FRAUD } = require("../config/teacherSuccess/thresholds");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? JSON.stringify(x) : ""); } };
const { ObjectId } = mongoose.Types;

let seq = 0;
const mkTeacher = (over = {}) => User.create({ name: "T", email: `rq${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true, referralCode: svc.generateCode(), ...over });
const mkReferee = (over = {}) => User.create({ name: "R", email: `rqe${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "pending", isVerified: true, ...over });
const mkExam = (owner, over = {}) => Exam.create({ name: "E", owner, duration: 3600, price: 0, totalMarks: 100, passingMarks: 50, mode: "structured", class: new ObjectId(), typePoints: { Cm: 50 }, ...over });
const mkResult = (userId, examId, createdAt) => Result.create({ userId, examId, attempts: 1, earnPoints: 50, attemptId: new ObjectId(), createdAt });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([User.createIndexes(), Result.createIndexes(), TeacherReferral.createIndexes()]);

  // ── assessQualification is pure + server-authoritative (never isVerified) ──
  ok("qualifies with age+exam+attempts+days", svc.assessQualification({ accountAgeDays: 8, publishedExams: 1, completedAttempts: 2, distinctActiveDays: 2 }).qualifies === true);
  ok("too-new account does not qualify", svc.assessQualification({ accountAgeDays: 3, publishedExams: 1, completedAttempts: 2, distinctActiveDays: 2 }).qualifies === false);
  ok("no published exam does not qualify", svc.assessQualification({ accountAgeDays: 8, publishedExams: 0, completedAttempts: 2, distinctActiveDays: 2 }).qualifies === false);
  ok("suspended/deleted never qualifies", svc.assessQualification({ accountAgeDays: 30, publishedExams: 5, completedAttempts: 20, distinctActiveDays: 5, suspendedOrDeleted: true }).qualifies === false);

  // ── qualifyReferee uses real activity evidence ──
  const A = await mkTeacher();
  const oldRef = await mkReferee({ createdAt: new Date(Date.now() - 10 * 86400000) }); // 10 days old
  await User.updateOne({ _id: oldRef._id }, { $set: { referredBy: A._id } });
  const referral = await TeacherReferral.create({ referrerId: A._id, refereeId: oldRef._id, code: A.referralCode, state: "pending" });
  // Not-yet-active referee stays pending
  const notReady = await svc.qualifyReferee({ referralId: referral._id, now: new Date() });
  ok("referee without activity stays pending", notReady.state === "pending" && notReady.qualification.qualifies === false);
  // Seed real activity: published exam + 2 completed attempts (real students) on distinct days
  const s1 = await User.create({ name: "S", email: `rqs${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  const s2 = await User.create({ name: "S", email: `rqs${seq++}@e.com`, password: "xxxxxxxx", role: "student", isVerified: true });
  const exam = await mkExam(oldRef._id, { activeVersionId: new ObjectId() });
  const dayA = new Date(Date.now() - 4 * 86400000);
  const dayB = new Date(Date.now() - 2 * 86400000);
  await mkResult(s1._id, exam._id, dayA);
  await mkResult(s2._id, exam._id, dayB);
  const ready = await svc.qualifyReferee({ referralId: referral._id, now: new Date(), signals: {} });
  ok("referee with real activity qualifies", ready.state === "qualified", ready.evidence);

  // ── CAS: concurrent qualify transitions exactly once ──
  const B = await mkTeacher();
  const ree = await mkReferee({ createdAt: new Date(Date.now() - 10 * 86400000) });
  await User.updateOne({ _id: ree._id }, { $set: { referredBy: B._id } });
  const ref2 = await TeacherReferral.create({ referrerId: B._id, refereeId: ree._id, code: B.referralCode, state: "pending" });
  const races = await Promise.all([1, 2, 3, 4].map(() => svc.qualify({ referralId: ref2._id, qualifies: true, signals: {} })));
  ok("concurrent qualify → exactly one non-idempotent transition", races.filter((r) => r.ok && !r.idempotent && r.state === "qualified").length === 1);

  // ── Claim rate-limit in bind ──
  const C = await mkTeacher();
  // Pre-fill the referrer with the cap of recent referrals.
  for (let i = 0; i < REFERRAL_FRAUD.maxClaimsPerWindow; i++) await TeacherReferral.create({ referrerId: C._id, refereeId: new ObjectId(), code: C.referralCode, state: "pending" });
  const late = await mkReferee();
  const capped = await svc.bind({ refereeId: late._id, code: C.referralCode });
  ok("bind rate-limited past the per-window cap", capped.ok === false && capped.code === "claim_rate_limited");

  // ── qualifiedCount capped per period ──
  const D = await mkTeacher();
  for (let i = 0; i < REFERRAL_FRAUD.maxRewardedPerPeriod + 5; i++) await TeacherReferral.create({ referrerId: D._id, refereeId: new ObjectId(), code: D.referralCode, state: "qualified" });
  ok("qualifiedCount is capped at maxRewardedPerPeriod", (await svc.qualifiedCount(D._id)) === REFERRAL_FRAUD.maxRewardedPerPeriod);

  // ── Durable binding recovery: referredBy set but no row → reconcile creates it ──
  const E = await mkTeacher();
  const orphan = await mkReferee();
  await User.updateOne({ _id: orphan._id }, { $set: { referredBy: E._id } }); // simulate crash after referredBy, before row
  ok("orphan has referredBy but no referral row", (await TeacherReferral.exists({ refereeId: orphan._id })) === null);
  const repaired = await svc.reconcilePendingBindings();
  ok("reconcile repairs the missing referral row", repaired >= 1 && !!(await TeacherReferral.exists({ refereeId: orphan._id })));

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
