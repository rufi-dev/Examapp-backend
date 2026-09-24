/* eslint-env node */
/*
 * What the storage limit promises.
 *
 * A count limit never bounded disk — five files is five scanned textbooks at
 * 400MB each — so the tiers now carry bytes. These assertions are about the two
 * things a limit has to be: correct per tier, and impossible to get past by
 * sending two uploads at the same moment.
 *
 * The concurrency case is the point. Summing, deciding and then writing is a
 * read-then-write, and the version before this one let both requests through.
 */
const assert = require("assert");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log("  ✓", name); } else { failed += 1; console.log("  ✗ FAIL:", name); }
};
const eq = (name, actual, expected) =>
  ok(`${name} (got ${JSON.stringify(actual)})`, JSON.stringify(actual) === JSON.stringify(expected));

(async () => {
  const MB = 1024 * 1024;

  // ── the tiers ────────────────────────────────────────────────────────────
  console.log("\n— what each tier may hold —");
  const { quotaFor, human } = require("../middleware/uploadLimit");
  eq("free is small enough to be a trial, not a host", quotaFor({ plan: "free" }) / MB, 50);
  eq("pro is a working library", quotaFor({ plan: "pro" }) / MB, 2048);
  eq("premium fits video", quotaFor({ plan: "premium" }) / MB, 15360);
  /*
   * An unreadable plan must not resolve to the most generous tier. This is the
   * direction a bug goes when a plan string is renamed or a record is corrupted,
   * and the expensive failure is the silent one.
   */
  eq("an unknown plan falls to the smallest allowance", quotaFor({ plan: "gold" }) / MB, 50);
  eq("...as does a missing one", quotaFor({}) / MB, 50);
  // The per-teacher override is the admin escape hatch and must survive a plan.
  eq("an explicit override wins over the tier", quotaFor({ plan: "free", storageQuotaBytes: 900 * MB }) / MB, 900);

  eq("sizes read the way a teacher writes them", [human(50 * MB), human(2048 * MB), human(900 * 1024)], ["50 MB", "2.0 GB", "900 KB"]);

  // ── the gate itself, against a real database ─────────────────────────────
  console.log("\n— the gate —");
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(), { dbName: "storage-test" });

  const User = require("../models/userModel");
  const Material = require("../models/materialModel");
  const { reserveStorage, storageStatus, recountStorage, usedBytes } = require("../middleware/uploadLimit");

  const makeUser = async (plan) =>
    User.create({ name: "Müəllim", email: `t${Date.now()}${Math.random()}@ex.test`, password: "xxxxxxxx", role: "teacher", plan });

  const addMaterial = (owner, bytes) =>
    Material.create({
      title: "fayl", fileName: `f${Math.random()}.pdf`, kind: "pdf", sizeBytes: bytes, owner,
    });

  {
    const u = await makeUser("free");
    const s0 = await storageStatus(u);
    eq("an empty account reads as empty", [s0.used, s0.percent, s0.full], [0, 0, false]);
    eq("...and shows the tier's own ceiling", s0.limitLabel, "50 MB");

    await addMaterial(u._id, 40 * MB);
    const s1 = await storageStatus(u);
    eq("what is stored is what is shown", s1.used / MB, 40);
    eq("...as a percentage of the tier", s1.percent, 80);
    ok("...and the remainder is spelled out", s1.remainingLabel === "10 MB");
    ok("not yet full", s1.full === false);

    // A file that does not fit is refused, and the refusal says the numbers.
    const tooBig = await reserveStorage(u, 20 * MB);
    ok("a file larger than the remainder is refused", tooBig.ok === false);
    ok("...and the message quotes the allowance, the usage and the file", /50 MB/.test(tooBig.message) && /40 MB/.test(tooBig.message) && /20 MB/.test(tooBig.message));

    const fits = await reserveStorage(u, 8 * MB);
    ok("a file that fits is allowed", fits.ok === true);
    await fits.release();
  }

  /*
   * TWO UPLOADS AT ONCE.
   *
   * This is the assertion the whole counter exists for. Both requests see 40MB
   * used and 10MB free; both are asking for 8MB. Exactly one may win. Before the
   * conditional $inc, both did — and the account ended up over its limit with
   * nothing in the logs to say how.
   */
  {
    const u = await makeUser("free");
    await addMaterial(u._id, 40 * MB);
    const [a, b] = await Promise.all([reserveStorage(u, 8 * MB), reserveStorage(u, 8 * MB)]);
    const winners = [a, b].filter((r) => r.ok).length;
    eq("two simultaneous uploads: exactly one is allowed", winners, 1);
    const after = await User.findById(u._id).select("storageBytes").lean();
    ok("...and the counter never exceeds the limit", after.storageBytes <= 50 * MB);
  }

  // A released claim gives the room back, so a rejected upload costs nothing.
  {
    const u = await makeUser("free");
    await addMaterial(u._id, 40 * MB);
    const claim = await reserveStorage(u, 9 * MB);
    ok("the claim is made", claim.ok === true);
    const blocked = await reserveStorage(u, 9 * MB);
    ok("...and it holds the room while it stands", blocked.ok === false);
    await claim.release();
    const later = await reserveStorage(u, 9 * MB);
    ok("...but releasing it gives the room back", later.ok === true);
  }

  // An account already over a newly lowered limit keeps its files.
  {
    const u = await makeUser("free");
    await addMaterial(u._id, 120 * MB); // uploaded before the tier existed
    const s = await storageStatus(u);
    ok("an account over the limit is shown as full", s.full === true);
    eq("...with the bar pinned rather than overflowing", s.percent, 100);
    eq("...and nothing left", s.remaining, 0);
    const blocked = await reserveStorage(u, 1 * MB);
    ok("...and cannot upload another byte", blocked.ok === false);
    eq("...while its files are untouched", await Material.countDocuments({ owner: u._id }), 1);
  }

  // Deleting is the way out, and the counter has to follow.
  {
    const u = await makeUser("free");
    const m1 = await addMaterial(u._id, 30 * MB);
    await addMaterial(u._id, 15 * MB);
    ok("a full-ish account is blocked", (await reserveStorage(u, 10 * MB)).ok === false);
    await Material.deleteOne({ _id: m1._id });
    await recountStorage(u._id);
    ok("deleting a file makes room", (await reserveStorage(u, 10 * MB)).ok === true);
    eq("...and the truth follows the rows", (await usedBytes(u._id)) / MB, 15);
  }

  /*
   * Drift may only ever make the gate STRICTER. A counter left high by a crash
   * costs a teacher room until it is reconciled; a counter left low would let
   * the account past its limit, which is the one direction that costs money.
   */
  {
    const u = await makeUser("free");
    await addMaterial(u._id, 10 * MB);
    await User.updateOne({ _id: u._id }, { $set: { storageBytes: 0 } }); // pretend drift
    const claim = await reserveStorage(u, 45 * MB);
    ok("a counter below the truth is repaired before it is trusted", claim.ok === false);
  }

  // An admin has no ceiling, and is not shown a meter at all.
  {
    const admin = { _id: new mongoose.Types.ObjectId(), role: "admin", plan: "free" };
    const claim = await reserveStorage(admin, 500 * MB);
    ok("an admin is never gated", claim.ok === true && claim.admin === true);
    const s = await storageStatus(admin);
    ok("...and has no limit to show", s.unlimited === true && s.limit === null);
  }

  await mongoose.disconnect();
  await mongod.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} storage assertions failed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
