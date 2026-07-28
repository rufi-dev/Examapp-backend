/*
 * Teacher Success Journey — referral binding, fraud, state machine (ADR §7).
 * Real in-memory Mongo. Proves: at-most-one immutable referrer; no self/
 * circular; a signup alone doesn't qualify; hard fraud -> rejected; soft signals
 * -> held; shared NAT alone never blocks; reward + revoke idempotent.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-ref";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const TeacherReferral = require("../models/teacherReferralModel");
const svc = require("../services/teacherReferralService");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

let seq = 0;
const mkTeacher = (over = {}) => User.create({ name: "T", email: `ref${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", isVerified: true, referralCode: svc.generateCode(), ...over });
const mkReferee = (over = {}) => User.create({ name: "R", email: `ree${seq++}@e.com`, password: "xxxxxxxx", role: "teacher", teacherApproval: "pending", isVerified: true, ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await User.createIndexes();
  await TeacherReferral.createIndexes();

  // ── Pure fraud assessment ──
  ok("no signals → qualified", svc.assessRisk({}).decision === "qualified");
  ok("self referral → rejected", svc.assessRisk({ selfReferral: true }).decision === "rejected");
  ok("reused verified phone → rejected", svc.assessRisk({ reusedVerifiedPhone: true }).decision === "rejected");
  ok("reused OAuth subject → rejected", svc.assessRisk({ reusedOAuthSubject: true }).decision === "rejected");
  ok("shared NAT ALONE (1 soft) → qualified (never blocks)", svc.assessRisk({ softSignals: ["shared_nat"] }).decision === "qualified");
  ok("2 soft signals → held (not rejected)", svc.assessRisk({ softSignals: ["shared_nat", "device_reuse"] }).decision === "held");

  // ── Binding: code, self, at-most-one, circular ──
  const A = await mkTeacher();
  const B = await mkReferee();
  const bindBad = await svc.bind({ refereeId: B._id, code: "nope" });
  ok("unknown code rejected", bindBad.ok === false && bindBad.code === "unknown_code");
  const bindSelf = await svc.bind({ refereeId: A._id, code: A.referralCode });
  ok("self-referral rejected", bindSelf.ok === false && bindSelf.code === "self_referral");
  const bind1 = await svc.bind({ refereeId: B._id, code: A.referralCode });
  ok("first bind succeeds (pending)", bind1.ok && bind1.referral.state === "pending");
  ok("referredBy set on the referee", String((await User.findById(B._id)).referredBy) === String(A._id));
  const C = await mkTeacher();
  const bind2 = await svc.bind({ refereeId: B._id, code: C.referralCode });
  ok("second referrer rejected (at most one, immutable)", bind2.ok === false && bind2.code === "already_referred");
  ok("referredBy is immutable (still A)", String((await User.findById(B._id)).referredBy) === String(A._id));

  // circular A→B then B→A refused
  const bindCirc = await svc.bind({ refereeId: A._id, code: (await User.findByIdAndUpdate(B._id, { $set: { referralCode: svc.generateCode() } }, { new: true })).referralCode });
  ok("circular A→B→A refused", bindCirc.ok === false && bindCirc.code === "circular");

  // ── A signup alone doesn't qualify ──
  const notYet = await svc.qualify({ referralId: bind1.referral._id, qualifies: false });
  ok("not-yet-qualifying referral stays pending", notYet.ok && notYet.state === "pending" && notYet.qualified === false);

  // ── Qualify: clean → qualified ──
  const q = await svc.qualify({ referralId: bind1.referral._id, qualifies: true, signals: {} });
  ok("qualifying + clean → qualified", q.ok && q.state === "qualified");
  ok("qualifiedCount(A) === 1", (await svc.qualifiedCount(A._id)) === 1);

  // ── Suspicious referral is HELD, not rewarded ──
  const D = await mkReferee();
  const bindD = await svc.bind({ refereeId: D._id, code: A.referralCode });
  const held = await svc.qualify({ referralId: bindD.referral._id, qualifies: true, signals: { softSignals: ["device_reuse", "disposable_email"] } });
  ok("suspicious referral held (not rewarded)", held.ok && held.state === "held");
  ok("held does not count toward eligibility", (await svc.qualifiedCount(A._id)) === 1);

  // ── Hard-fraud referral rejected ──
  const E = await mkReferee();
  const bindE = await svc.bind({ refereeId: E._id, code: A.referralCode });
  const rej = await svc.qualify({ referralId: bindE.referral._id, qualifies: true, signals: { reusedVerifiedPhone: true } });
  ok("hard-fraud referral rejected", rej.ok && rej.state === "rejected");

  // ── Reward: only qualified; idempotent ──
  const rw1 = await svc.reward({ referralId: bind1.referral._id, rewardKey: "rk-1" });
  ok("qualified → rewarded", rw1.ok && rw1.state === "rewarded" && !rw1.idempotent);
  const rw2 = await svc.reward({ referralId: bind1.referral._id, rewardKey: "rk-1" });
  ok("reward idempotent", rw2.ok && rw2.idempotent === true);
  const rwHeld = await svc.reward({ referralId: bindD.referral._id, rewardKey: "rk-2" });
  ok("cannot reward a held referral", rwHeld.ok === false && rwHeld.code === "not_qualified");
  ok("rewarded still counts toward eligibility", (await svc.qualifiedCount(A._id)) === 1);

  // ── Concurrent reward of one referral rewards once ──
  const F = await mkReferee();
  const bindF = await svc.bind({ refereeId: F._id, code: A.referralCode });
  await svc.qualify({ referralId: bindF.referral._id, qualifies: true, signals: {} });
  const races = await Promise.all([1, 2, 3, 4].map((i) => svc.reward({ referralId: bindF.referral._id, rewardKey: `frace-${i}` })));
  ok("exactly one concurrent reward is non-idempotent", races.filter((r) => r.ok && !r.idempotent).length === 1);

  // ── Revoke: idempotent, never removes core access ──
  const rev1 = await svc.revoke({ referralId: bind1.referral._id, reason: "proven fraud", actorId: A._id });
  ok("revoke moves to revoked", rev1.ok && rev1.state === "revoked");
  const rev2 = await svc.revoke({ referralId: bind1.referral._id, reason: "again" });
  ok("revoke idempotent", rev2.ok && rev2.idempotent === true);
  ok("revoked no longer counts toward eligibility", (await svc.qualifiedCount(A._id)) === 1); // F still rewarded
  const aStill = await User.findById(A._id).lean();
  ok("revoke never touched referrer's role/approval (core access intact)", aStill.role === "teacher" && aStill.teacherApproval === "approved");

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
