/*
 * AUD-001 regression: result endpoints must never serialize a user's password
 * hash (or other private user fields). Covers getResultsByExam (teacher list)
 * and getResultsByUserByExam (a student's own per-exam results).
 *
 * Controller-level test against in-memory Mongo (matches the repo's existing
 * test style; no HTTP server / supertest dependency). Calls the real exported
 * controllers with mock req/res and asserts the JSON payload.
 *
 * Test IDs: AUD-001-T1 (student own results), AUD-001-T2 (owner teacher list).
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Result = require("../../models/resultModel");
const Exam = require("../../models/examModel");
const User = require("../../models/userModel");
const {
  getResultsByExam,
  getResultsByUserByExam,
} = require("../../controllers/quizController");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// Minimal mock res that captures status + json; next rethrows so a controller
// error fails the test loudly instead of silently passing.
function mockRes() {
  return {
    _status: 200,
    _json: undefined,
    status(c) { this._status = c; return this; },
    json(p) { this._json = p; return this; },
  };
}
const next = (err) => { if (err) throw err; };

// Deep search for a forbidden key anywhere in the ACTUAL wire payload — the
// JSON the client receives (res.json runs the doc through toJSON), not the
// Mongoose document's internal metadata.
const FORBIDDEN = ["password"];
function findForbidden(payload, path = "") {
  const obj = JSON.parse(JSON.stringify(payload ?? null));
  const walk = (o, p) => {
    if (o == null || typeof o !== "object") return null;
    for (const k of Object.keys(o)) {
      if (FORBIDDEN.includes(k)) return `${p}.${k}`;
      const hit = walk(o[k], `${p}.${k}`);
      if (hit) return hit;
    }
    return null;
  };
  return walk(obj, path);
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const teacher = await User.create({ name: "T", email: "t@e.com", password: "supersecret123", role: "teacher" });
  const student = await User.create({ name: "S", email: "s@e.com", password: "studentsecret9", role: "student" });
  const exam = await Exam.create({
    name: "E", owner: teacher._id, duration: 600, price: 0,
    totalMarks: 100, passingMarks: 50, class: new mongoose.Types.ObjectId(),
    showScore: true,
  });
  await Result.create({
    userId: student._id, examId: exam._id, attempts: 1, earnPoints: 42,
    attemptId: new mongoose.Types.ObjectId(),
  });

  // AUD-001-T2: owner teacher requests the exam's result list.
  {
    const res = mockRes();
    await getResultsByExam({ params: { examId: String(exam._id) }, user: teacher }, res, next);
    ok("getResultsByExam returns 200", res._status === 200);
    ok("getResultsByExam populated the student user", res._json?.[0]?.userId?.name === "S");
    const leak = findForbidden(res._json);
    ok("getResultsByExam: NO password field anywhere in payload" + (leak ? ` (leaked at ${leak})` : ""), leak === null);
  }

  // AUD-001-T1: the student requests their own results for this exam.
  {
    const res = mockRes();
    await getResultsByUserByExam({ params: { examId: String(exam._id) }, user: student }, res, next);
    ok("getResultsByUserByExam returns 200", res._status === 200);
    ok("getResultsByUserByExam populated the student user", res._json?.[0]?.userId?.name === "S");
    const leak = findForbidden(res._json);
    ok("getResultsByUserByExam: NO password field anywhere in payload" + (leak ? ` (leaked at ${leak})` : ""), leak === null);
  }

  // Sanity: the login path still explicitly loads the hash (schema select:false
  // must not break password comparison).
  {
    const withPw = await User.findOne({ email: "t@e.com" }).select("+password");
    ok("auth path can still load the password hash via +password", typeof withPw?.password === "string" && withPw.password.length > 0);
    const normal = await User.findOne({ email: "t@e.com" });
    ok("default query does NOT include the password hash", normal?.password === undefined);
  }

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
