/*
 * AUD-002 Gate 2 (CR-021) — worker lifecycle + two-worker ownership.
 *  - flag-off startup starts NO worker timer; flag-on starts exactly once and its
 *    shutdown hook stops exactly once (DI helper, no real timer).
 *  - two concurrent workers claim/complete ONE pending action exactly once.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-wl";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const PendingSecurityAction = require("../../models/pendingSecurityActionModel");
const { maybeStartWorker } = require("../../jobs/workerLifecycle");
const worker = require("../../jobs/outboxWorker");
const svc = require("../../services/sessionService");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

async function main() {
  // --- Lifecycle (no DB needed) ---
  {
    let started = 0, stopped = 0;
    const fakeStart = () => { started += 1; return () => { stopped += 1; }; };

    const offStop = maybeStartWorker({ flags: { SESSION_MODEL_ENABLED: false }, startWorker: fakeStart });
    ok("flag-off: maybeStartWorker returns null (no worker)", offStop === null);
    ok("flag-off: startWorker was NOT called (no timer)", started === 0);

    const onStop = maybeStartWorker({ flags: { SESSION_MODEL_ENABLED: true }, startWorker: fakeStart });
    ok("flag-on: startWorker called exactly once", started === 1 && typeof onStop === "function");
    onStop();
    ok("flag-on: shutdown stops the worker exactly once", stopped === 1);
  }

  // --- Two-worker ownership (one action processed exactly once) ---
  {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    const u = await User.create({ name: "W", email: "wl@e.com", password: "origPass12", role: "student" }); // sv 0
    await svc.enqueuePending("sv-bump", { userId: u._id, sid: "sidWL", targetVersion: 1, reason: "refresh-reuse" });

    const [a, b] = await Promise.all([
      worker.drainOnce({ workerId: "worker-A" }),
      worker.drainOnce({ workerId: "worker-B" }),
    ]);
    const totalDone = (a.done || 0) + (b.done || 0);
    const totalStale = (a.stale || 0) + (b.stale || 0);
    ok("two workers ⇒ exactly ONE owned completion", totalDone === 1);
    ok("two workers ⇒ no stale delete miscounted as done", totalStale === 0);
    ok("two workers ⇒ the fence effect is applied exactly once", (await User.findById(u._id)).sessionVersion === 1);
    ok("two workers ⇒ the record is removed (by its lease owner only)", (await PendingSecurityAction.countDocuments({ _id: "sv-bump:sidWL:1" })) === 0);

    await mongoose.disconnect();
    await mem.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
