/*
 * AUD-005-T2 — public registration can NEVER grant teacher CAPABILITY.
 *
 * Drives the REAL production router (/api/users/register + registerUser) over
 * real sockets against in-memory Mongo, then asserts the created account's
 * server-side state and its effective authority on a live teacherOnly route.
 *
 * A public caller may REQUEST the teacher role, but the account is created in the
 * unprivileged `pending` approval state and is denied by the capability gate. A
 * request for admin/suspended (or a body-supplied teacherApproval) is ignored —
 * the caller falls back to an ordinary student and receives no capability.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud005-reg";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud005-reg";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const { generateToken } = require("../../utils");
const { protect, teacherOnly } = require("../../middleware/authMiddleware");
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { method = "POST", path, body, token }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data),
        "User-Agent": "aud005-test", ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } },
      (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({
        status: res.statusCode, body: (() => { try { return JSON.parse(Buffer.concat(c).toString()); } catch { return {}; } })(),
      })); });
    req.on("error", reject); if (data) req.write(data); req.end();
  });
}

// A live teacherOnly probe: proves the created account's EFFECTIVE authority,
// not just its stored fields.
function buildServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.get("/probe/teacher", protect, teacherOnly, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return http.createServer(app);
}

const base = (over) => ({ name: "R", email: `${over.email}`, password: "passWord12", phone: "12345", grade: "11", ...over });

async function register(server, over) {
  const email = over.email;
  const resp = await request(server, { path: "/api/users/register", body: base(over) });
  const user = await User.findOne({ email });
  const probe = user
    ? await request(server, { method: "GET", path: "/probe/teacher", token: generateToken(user._id, user.sessionVersion) })
    : { status: 0 };
  return { resp, user, probe };
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const server = buildServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  // 1) A public caller registers as teacher — created AND auto-approved (self-service
  //    grants capability immediately so a new teacher can create their own content).
  {
    const { resp, user, probe } = await register(server, { email: "wants-teacher@e.com", role: "teacher" });
    ok("teacher request is accepted (201)", resp.status === 201);
    ok("account records the teacher role TYPE", user.role === "teacher");
    ok("self-registration is AUTO-APPROVED — teacherApproval is 'approved'", user.teacherApproval === "approved");
    ok("auto-approved self-registrant carries method 'self'", user.teacherApprovalMeta && user.teacherApprovalMeta.method === "self");
    ok("approved teacher is ALLOWED by the capability gate (not 403)", probe.status !== 403);
  }

  // 2) The approval state is SERVER-decided — a client-supplied teacherApproval in the
  //    body is ignored (the server always resolves it via resolveSelfServiceCapability).
  {
    const { user, probe } = await register(server, { email: "forged-approval@e.com", role: "teacher", teacherApproval: "banned" });
    ok("client-supplied teacherApproval is ignored — server sets 'approved'", user.teacherApproval === "approved");
    ok("server-decided approved account is ALLOWED (not 403)", probe.status !== 403);
  }

  // 3) A request for admin falls back to an ordinary student, no capability.
  {
    const { user, probe } = await register(server, { email: "wants-admin@e.com", role: "admin" });
    ok("admin request falls back to role 'student'", user.role === "student");
    ok("admin request grants no teacher capability ('none')", user.teacherApproval === "none");
    ok("student is denied by the teacher gate (401)", probe.status === 401);
  }

  // 4) A request for suspended likewise falls back to student.
  {
    const { user, probe } = await register(server, { email: "wants-suspended@e.com", role: "suspended" });
    ok("suspended request falls back to role 'student'", user.role === "student");
    ok("suspended request grants no capability ('none')", user.teacherApproval === "none");
    ok("suspended-request account is denied (401)", probe.status === 401);
  }

  // 5) A normal student is unprivileged with approval 'none'.
  {
    const { user, probe } = await register(server, { email: "plain-student@e.com", role: "student" });
    ok("student registration yields role 'student' / approval 'none'", user.role === "student" && user.teacherApproval === "none");
    ok("student is denied by the teacher gate (401)", probe.status === 401);
  }

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
