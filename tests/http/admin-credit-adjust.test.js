/*
 * Admin credit adjustments are BOUNDED and AUDITED (EX-04).
 *
 * A platform review on 2026-09-22 found one teacher holding 11,001,724 credits
 * while every other Premium account held about 2,000 — and not one ledger row
 * anywhere explained it. The endpoint behind the admin screen accepted any
 * finite number, wrote it straight onto the user, and recorded nothing: no
 * actor, no reason, no before/after. A mistyped amount was indistinguishable
 * from a deliberate grant, and afterwards nobody could tell which it had been.
 *
 * These tests hold the two properties that make that impossible to repeat: a
 * number far outside real use is refused, and every accepted change leaves a
 * trail written BEFORE the balance moves.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-credit-adjust";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-credit-adjust";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const MaintenanceAudit = require("../../models/maintenanceAuditModel");
const { generateToken } = require("../../utils");
const userRouter = require("../../routes/userRoute"); // the SHIPPING router
const errorHandler = require("../../middleware/errorMiddleware");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", name, extra ? `— ${extra}` : "");
  }
};

function request(server, { method, path, token, body }) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json = {};
          try {
            json = JSON.parse(text);
          } catch {
            /* a non-JSON body is reported as-is */
          }
          resolve({ status: res.statusCode, body: json, text });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const admin = await User.create({
    name: "Admin", email: "admin@example.com", password: "x".repeat(12), role: "admin",
  });
  const teacher = await User.create({
    name: "Müəllim", email: "teacher@example.com", password: "x".repeat(12), role: "teacher", aiCredits: 500,
  });

  const app = express();
  app.use(express.json());
  app.use("/api/users", userRouter);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const token = generateToken(admin._id, admin.sessionVersion);
  const adjust = (body) =>
    request(server, { method: "PATCH", path: `/api/users/${teacher._id}/credits`, token, body });
  const balance = async () => (await User.findById(teacher._id).select("aiCredits").lean()).aiCredits;

  console.log("\nadmin credit adjustment — what is refused");

  let res = await adjust({ delta: 300 });
  ok("an adjustment with NO reason is refused", res.status === 400, `got ${res.status}`);
  ok("  and the balance did not move", (await balance()) === 500);

  res = await adjust({ delta: 11001724, reason: "fat finger" });
  ok("the exact amount from the review (11,001,724) is refused", res.status === 400, `got ${res.status}`);
  ok("  and the balance did not move", (await balance()) === 500);
  ok("  the message says what the limit is", /100/.test(res.body.message || ""), res.body.message);

  res = await adjust({ set: 999999999, reason: "absolute, far too large" });
  ok("an absolute set past the balance cap is refused", res.status === 400, `got ${res.status}`);
  ok("  and the balance did not move", (await balance()) === 500);

  res = await adjust({ delta: 0, reason: "nothing" });
  ok("a zero adjustment is refused", res.status === 400);
  res = await adjust({ delta: "abc", reason: "nonsense" });
  ok("a non-numeric adjustment is refused", res.status === 400);
  res = await adjust({ set: -5, reason: "negative" });
  ok("a negative absolute value is refused", res.status === 400);

  console.log("\nwhat is allowed — and what it leaves behind");

  res = await adjust({ delta: 300, reason: "Ödəniş qəbul edildi" });
  ok("a real top-up (+300) succeeds", res.status === 200 && res.body.aiCredits === 800, JSON.stringify(res.body));
  ok("  the reply reports where it came from", res.body.from === 500);

  const audits = await MaintenanceAudit.find({ action: "user_credits_adjust" }).lean();
  ok("it wrote exactly ONE audit row", audits.length === 1, `got ${audits.length}`);
  const a = audits[0] || {};
  ok("  naming the admin who did it", String(a.actor) === String(admin._id));
  ok("  the reason they gave", a.reason === "Ödəniş qəbul edildi");
  ok("  and the before/after balance", a.target && a.target.from === 500 && a.target.to === 800, JSON.stringify(a.target));

  res = await adjust({ delta: -1000, reason: "Düzəliş" });
  ok("a correction downwards is allowed", res.status === 200);
  ok("  and never goes below zero", (await balance()) === 0, String(await balance()));

  const refusedAudits = await MaintenanceAudit.countDocuments({ action: "user_credits_adjust" });
  ok("a REFUSED adjustment writes no audit row (only accepted ones)", refusedAudits === 2, `rows: ${refusedAudits}`);

  console.log("\nauthorization is unchanged");
  const teacherToken = generateToken(teacher._id, teacher.sessionVersion);
  res = await request(server, {
    method: "PATCH", path: `/api/users/${teacher._id}/credits`, token: teacherToken, body: { delta: 100, reason: "self-serve" },
  });
  ok("a teacher cannot adjust their own credits", res.status === 401 || res.status === 403, `got ${res.status}`);
  ok("  and the balance is untouched", (await balance()) === 0);

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(2);
});
