/*
 * Teacher Success Journey — HTTP surface (ADR §9/§10/§13). Real sockets +
 * in-memory Mongo, mounting the REAL router/controller/services. Proves:
 * flag-off 404s the whole surface; a new Spark teacher sees Spark + 100 credits;
 * admin promotion updates the teacher live to Momentum + 300; grant raises
 * remaining; upgrade-request idempotent; students are refused; no payment wording.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tsj-http";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-tsj-http";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const AiCreditPeriod = require("../../models/aiCreditPeriodModel");
const AiCreditLedger = require("../../models/aiCreditLedgerModel");
const TeacherReferral = require("../../models/teacherReferralModel");
const TeacherUpgradeRequest = require("../../models/teacherUpgradeRequestModel");
const TeacherLevelHistory = require("../../models/teacherLevelHistoryModel");
const { generateToken } = require("../../utils");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c, x) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, x ? "\n    " + JSON.stringify(x) : ""); } };

function request(server, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: {
      "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })() })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

let seq = 0;
const mkUser = (over) => User.create({ name: "U", email: `tsjh${seq++}@e.com`, password: "xxxxxxxx", isVerified: true, ...over });

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Promise.all([AiCreditPeriod.createIndexes(), AiCreditLedger.createIndexes(), TeacherReferral.createIndexes(), TeacherUpgradeRequest.createIndexes(), TeacherLevelHistory.createIndexes(), User.createIndexes()]);

  const app = express();
  app.use(express.json());
  app.use("/api/teacher-success", require("../../routes/teacherSuccessRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const spark = await mkUser({ role: "teacher", teacherApproval: "pending", teacherLevel: "spark", levelVersion: 0 });
  const momentum = await mkUser({ name: "Momentum Teacher", role: "teacher", teacherApproval: "approved", teacherLevel: "momentum", levelVersion: 2 });
  await mkUser({ name: "Impact Teacher", role: "teacher", teacherApproval: "approved", teacherLevel: "impact", levelVersion: 4 });
  const admin = await mkUser({ role: "admin" });
  const student = await mkUser({ role: "student" });
  const tok = (u) => generateToken(u._id, u.sessionVersion);

  // ── Flag OFF: the whole surface is 404 ──
  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  ok("flag off: GET /me → 404", (await request(server, { method: "GET", path: "/api/teacher-success/me", token: tok(spark) })).status === 404);

  // ── Flag ON ──
  process.env.TEACHER_SUCCESS_JOURNEY_ENABLED = "1";

  // ── Admin directory: every teacher, visible level + AI, bounded pagination ──
  const directory = await request(server, { method: "GET", path: "/api/teacher-success/admin/teachers?limit=2", token: tok(admin) });
  ok("admin teacher directory is paginated", directory.status === 200 && directory.body.teachers.length === 2 && directory.body.nextCursor, directory.body);
  ok("directory exposes level/version and AI balance for each teacher", directory.body.teachers.every((t) =>
    ["spark", "momentum", "impact"].includes(t.level) &&
    Number.isSafeInteger(t.levelVersion) &&
    t.credits &&
    Number.isSafeInteger(t.credits.baseAllowance) &&
    Number.isSafeInteger(t.credits.remaining)
  ), directory.body.teachers);
  const directory2 = await request(server, { method: "GET", path: `/api/teacher-success/admin/teachers?limit=2&cursor=${encodeURIComponent(directory.body.nextCursor)}`, token: tok(admin) });
  ok("admin can page through every teacher without duplicates", directory2.status === 200 &&
    directory2.body.teachers.length >= 1 &&
    !directory2.body.teachers.some((t) => directory.body.teachers.some((x) => x.id === t.id)), directory2.body);
  const searched = await request(server, { method: "GET", path: "/api/teacher-success/admin/teachers?q=Momentum%20Teacher", token: tok(admin) });
  ok("directory search finds a teacher by name", searched.status === 200 && searched.body.teachers.length === 1 && searched.body.teachers[0].id === String(momentum._id), searched.body);
  ok("student cannot list teachers", (await request(server, { method: "GET", path: "/api/teacher-success/admin/teachers", token: tok(student) })).status === 401);

  // ── Admin detail: completed tasks, requirements, metrics, credits, history ──
  const detail = await request(server, { method: "GET", path: `/api/teacher-success/admin/teacher/${momentum._id}`, token: tok(admin) });
  ok("admin teacher detail includes all server-derived missions", detail.status === 200 && detail.body.missions.length === 8 &&
    detail.body.missions.every((m) => ["complete", "active", "locked"].includes(m.status)), detail.body);
  ok("admin detail includes activity requirements, metrics and AI credits", detail.body.requirements &&
    detail.body.metrics && detail.body.credits && detail.body.credits.baseAllowance === 300 &&
    Array.isArray(detail.body.levelHistory), detail.body);

  const me1 = await request(server, { method: "GET", path: "/api/teacher-success/me", token: tok(spark) });
  ok("Spark teacher sees level spark + 100 credits", me1.status === 200 && me1.body.level === "spark" && me1.body.credits.baseAllowance === 100 && me1.body.credits.remaining === 100, me1.body);
  ok("copy is activity-based, not paid (no payment wording)", /not a paid plan/i.test(me1.body.positioning.en) && !/\$|subscription|price/i.test(JSON.stringify(me1.body)));
  ok("entitlements: current core present, next level shown", me1.body.entitlements.current.core.includes("manual_pdf_exam") && me1.body.entitlements.next);

  const ref = await request(server, { method: "GET", path: "/api/teacher-success/referral", token: tok(spark) });
  ok("referral code + link issued", ref.status === 200 && typeof ref.body.code === "string" && ref.body.link === `/register?ref=${ref.body.code}`);

  const up1 = await request(server, { method: "POST", path: "/api/teacher-success/upgrade-request", token: tok(spark), body: { reason: "growing", classStudentSize: 40 } });
  ok("upgrade request opens", up1.status === 200 && up1.body.request.targetLevel === "momentum" && !up1.body.idempotent);
  const up2 = await request(server, { method: "POST", path: "/api/teacher-success/upgrade-request", token: tok(spark), body: { reason: "again" } });
  ok("upgrade request idempotent over HTTP", up2.status === 200 && up2.body.idempotent === true);

  // ── Student refused ──
  ok("student refused on /me (403)", (await request(server, { method: "GET", path: "/api/teacher-success/me", token: tok(student) })).status === 403);
  ok("student cannot hit admin promote (401 adminOnly)", (await request(server, { method: "POST", path: "/api/teacher-success/admin/promote", token: tok(student), body: {} })).status === 401);

  // ── Admin promotes; teacher updates live ──
  const prom = await request(server, { method: "POST", path: "/api/teacher-success/admin/promote", token: tok(admin), body: { teacherId: String(spark._id), fromLevel: "spark", fromVersion: 0, reason: "consistent activity" } });
  ok("admin promote spark→momentum (200)", prom.status === 200 && prom.body.level === "momentum");
  const me2 = await request(server, { method: "GET", path: "/api/teacher-success/me", token: tok(spark) });
  ok("teacher header updates live to Momentum + 300 credits", me2.status === 200 && me2.body.level === "momentum" && me2.body.credits.baseAllowance === 300 && me2.body.credits.remaining === 300, me2.body.credits);

  // ── Admin grant raises remaining ──
  const grant = await request(server, { method: "POST", path: "/api/teacher-success/admin/grant", token: tok(admin), body: { teacherId: String(spark._id), amount: 50, reason: "boost", grantKey: "admin.grant.testkey01" } });
  ok("admin grant 50 (200)", grant.status === 200 && grant.body.granted === 50, { status: grant.status, body: grant.body });
  const me3 = await request(server, { method: "GET", path: "/api/teacher-success/me", token: tok(spark) });
  ok("granted credits raise remaining to 350", me3.body.credits.remaining === 350);

  // ── Admin can deliberately downgrade; CAS + audit version remain authoritative ──
  const down = await request(server, { method: "POST", path: "/api/teacher-success/admin/correct", token: tok(admin), body: {
    teacherId: String(spark._id), fromLevel: "momentum", fromVersion: 1, toLevel: "spark", reason: "Manual admin downgrade",
  } });
  ok("admin can downgrade momentum→spark (200)", down.status === 200 && down.body.level === "spark" && down.body.levelVersion === 2, down.body);
  const downgradedDetail = await request(server, { method: "GET", path: `/api/teacher-success/admin/teacher/${spark._id}`, token: tok(admin) });
  ok("downgrade is visible with updated AI allowance and audit history", downgradedDetail.status === 200 &&
    downgradedDetail.body.teacher.level === "spark" &&
    downgradedDetail.body.credits.baseAllowance === 300 &&
    downgradedDetail.body.credits.remaining === 350 &&
    downgradedDetail.body.levelHistory.some((h) => h.kind === "correction" && h.fromLevel === "momentum" && h.toLevel === "spark"), downgradedDetail.body);

  // ── Admin inbox sees the upgrade request ──
  const inbox = await request(server, { method: "GET", path: "/api/teacher-success/admin/upgrade-requests?status=open", token: tok(admin) });
  ok("admin inbox lists the open upgrade request", inbox.status === 200 && inbox.body.requests.length === 1);

  delete process.env.TEACHER_SUCCESS_JOURNEY_ENABLED;
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
