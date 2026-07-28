/*
 * AUD-008 CR-051 — account-aware login throttling. A per-account FAILED-login
 * bucket (HMAC canonical email) bounds a distributed attack across many IPs, while
 * a shared NAT with many distinct identities stays usable. Plus: success clears
 * the bucket, the memory store is hard-bounded, 429 carries Retry-After, and a
 * label-safe metric is emitted.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud008-acct";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud008-acct";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const errorHandler = require("../../middleware/errorMiddleware");
const authLimit = require("../../middleware/authLimit");
const authMetrics = require("../../utils/authMetrics");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function request(server, { path, body, xff }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const { port } = server.address();
    const headers = { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), "User-Agent": "acct" };
    if (xff) headers["X-Forwarded-For"] = xff;
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
      const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, retryAfter: res.headers["retry-after"] }));
    });
    req.on("error", reject); req.write(data); req.end();
  });
}

async function main() {
  // ── unit: the bounded MemoryStore never exceeds its hard cap ──
  const store = new authLimit.MemoryStore(5);
  for (let i = 0; i < 50; i++) store.bump("k" + i, 60000, Date.now());
  ok("MemoryStore is hard-bounded (size <= max after 50 distinct keys)", store.size <= 5);

  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await User.createIndexes();
  await User.create({ name: "V", email: "victim@e.com", password: "goodpass1", phone: "+99450", role: "student", grade: "11", isVerified: true, userAgent: [] });

  const app = express();
  app.set("trust proxy", true); // so X-Forwarded-For drives req.ip (distinct attacker IPs)
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  const login = (email, password, xff) => request(server, { path: "/api/users/login", body: { email, password }, xff });

  // ── different IPs attacking ONE account hit the account cap ──
  authLimit.__resetForTest();
  authLimit.__setForTest({ login: { max: 1e9 }, account: { max: 3, windowMs: 60000 } });
  authMetrics._reset();
  const r1 = await login("victim@e.com", "wrongpass1", "9.9.9.1");
  const r2 = await login("victim@e.com", "wrongpass1", "9.9.9.2");
  const r3 = await login("victim@e.com", "wrongpass1", "9.9.9.3");
  const r4 = await login("victim@e.com", "wrongpass1", "9.9.9.4"); // 4th from a NEW IP
  ok("first 3 failed logins are 400 (not 429)", r1.status === 400 && r2.status === 400 && r3.status === 400);
  ok("4th attempt on the SAME account from a NEW IP is 429", r4.status === 429);
  ok("account 429 carries Retry-After", Number(r4.retryAfter) > 0);
  ok("label-safe account-throttle metric emitted", (await authMetrics.snapshot()).counters.auth_account_throttle_total >= 1);

  // ── many DIFFERENT accounts behind ONE IP stay usable (NAT-safe) ──
  authLimit.__resetForTest();
  authLimit.__setForTest({ login: { max: 1e9 }, account: { max: 3, windowMs: 60000 } });
  let anyBlocked = false;
  for (let i = 0; i < 6; i++) {
    const r = await login(`student${i}@e.com`, "wrongpass1", "10.0.0.1"); // one shared NAT IP
    if (r.status === 429) anyBlocked = true;
  }
  ok("6 distinct identities from one NAT IP are NOT blocked (each account bucket = 1 fail)", anyBlocked === false);

  // ── success CLEARS the account failure bucket ──
  authLimit.__resetForTest();
  authLimit.__setForTest({ login: { max: 1e9 }, account: { max: 3, windowMs: 60000 } });
  await login("victim@e.com", "wrongpass1", "1.1.1.1");
  await login("victim@e.com", "wrongpass1", "1.1.1.1"); // 2 fails
  const good = await login("victim@e.com", "goodpass1", "1.1.1.1"); // success → clears
  ok("a correct login succeeds despite prior failures (200)", good.status === 200);
  const afterClear = await login("victim@e.com", "wrongpass1", "1.1.1.1"); // bucket reset → 1 fail, not blocked
  ok("after a success, the account bucket is cleared (next fail not blocked)", afterClear.status === 400);

  authLimit.__resetForTest();
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
