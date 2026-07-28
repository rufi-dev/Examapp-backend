/*
 * Teacher Success Journey — upgrade request idempotency + decision (ADR §10).
 * Real in-memory Mongo. One open request per {teacher,target}; retried submit is
 * idempotent; a request never grants a level; decisions are audited.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-upreq";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const TeacherUpgradeRequest = require("../models/teacherUpgradeRequestModel");
const svc = require("../services/teacherUpgradeRequestService");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const { ObjectId } = mongoose.Types;

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await TeacherUpgradeRequest.createIndexes();

  const teacher = new ObjectId();
  const admin = new ObjectId();

  // ── must be a single step up ──
  ok("spark→impact rejected (not one step)", (await svc.submit({ teacherId: teacher, currentLevel: "spark", targetLevel: "impact" })).code === "not_one_step");

  // ── first submit opens a request ──
  const s1 = await svc.submit({ teacherId: teacher, currentLevel: "spark", targetLevel: "momentum", reason: "growing", classStudentSize: 40 });
  ok("first submit opens a request", s1.ok && s1.request.status === "open" && !s1.idempotent);

  // ── retried submit is idempotent (one open per {teacher,target}) ──
  const s2 = await svc.submit({ teacherId: teacher, currentLevel: "spark", targetLevel: "momentum", reason: "growing again" });
  ok("retried submit idempotent (same open request)", s2.ok && s2.idempotent === true && String(s2.request._id) === String(s1.request._id));
  ok("only one open request exists", (await TeacherUpgradeRequest.countDocuments({ teacherId: teacher, status: "open" })) === 1);

  // ── concurrent submits create exactly one ──
  const teacher2 = new ObjectId();
  const races = await Promise.all([1, 2, 3, 4, 5].map(() => svc.submit({ teacherId: teacher2, currentLevel: "spark", targetLevel: "momentum", reason: "x" })));
  ok("all concurrent submits succeed", races.every((r) => r.ok));
  ok("exactly one non-idempotent among concurrent submits", races.filter((r) => !r.idempotent).length === 1);
  ok("only one open request after concurrency", (await TeacherUpgradeRequest.countDocuments({ teacherId: teacher2, status: "open" })) === 1);

  // ── decision requires reason; is audited; frees the slot ──
  const decNoReason = await svc.decide({ requestId: s1.request._id, reviewer: admin, status: "approved", decisionReason: "  " });
  ok("decision without reason refused", decNoReason.ok === false && decNoReason.code === "reason_required");
  const dec = await svc.decide({ requestId: s1.request._id, reviewer: admin, status: "approved", decisionReason: "meets criteria" });
  ok("decision recorded with reviewer + reason", dec.ok && dec.request.status === "approved" && String(dec.request.reviewer) === String(admin) && dec.request.decisionReason === "meets criteria");
  const decAgain = await svc.decide({ requestId: s1.request._id, reviewer: admin, status: "denied", decisionReason: "x" });
  ok("cannot decide an already-decided request", decAgain.ok === false && decAgain.code === "already_decided");

  // ── after a decision the teacher can open a fresh request for the same target ──
  const s3 = await svc.submit({ teacherId: teacher, currentLevel: "spark", targetLevel: "momentum", reason: "re-request" });
  ok("a new open request can be opened after the prior one was decided", s3.ok && !s3.idempotent);

  // ── inbox + teacher listing ──
  ok("inbox lists open requests", (await svc.listInbox({ status: "open" })).length >= 1);
  ok("teacher listing returns their requests", (await svc.listForTeacher(teacher)).length === 2);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
