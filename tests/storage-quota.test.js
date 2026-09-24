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

  /*
   * A lapsed subscription loses the allowance, like every other limit. This read
   * the STORED plan rather than the effective one, so a Premium that expired last
   * month kept 15GB — the only limit a payment stopping did not touch.
   */
  const DAY = 86400000;
  const lapsed = { plan: "premium", planExpiresAt: new Date(Date.now() - DAY) };
  eq("a lapsed premium falls back to free", quotaFor(lapsed) / MB, 50);
  eq("...and a live one does not", quotaFor({ plan: "premium" }) / MB, 15360);
  eq("a plan with time left keeps its own", quotaFor({ plan: "pro", planExpiresAt: new Date(Date.now() + DAY) }) / MB, 2048);

  // There is no file COUNT limit any more; the library is sold by size alone.
  const { limitsFor } = require("../config/plans");
  ok("no tier declares a file count", ["free", "pro", "premium"].every((p) => limitsFor(p).materials === undefined));

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

  /*
   * Extra storage bought on its own — monthly, because the cost is monthly.
   *
   * The questions these answer are the ones a teacher will actually ask: does it
   * ADD to my plan or replace it, what happens on the day it runs out, and does
   * renewing early cost me the days I already paid for.
   */
  console.log("\n— rented extra storage —");
  {
    const DAY = 86400000;
    const base = quotaFor({ plan: "free" });
    eq("an add-on ADDS to the plan", quotaFor({ plan: "free", storageAddonGb: 10 }) - base, 10 * 1024 * MB);
    eq("...on any tier", quotaFor({ plan: "pro", storageAddonGb: 10 }) / MB, 2048 + 10 * 1024);
    // Rent, not a purchase: the month it covered has ended.
    eq("a lapsed add-on is worth nothing", quotaFor({ plan: "free", storageAddonGb: 10, storageAddonExpiresAt: new Date(Date.now() - DAY) }), base);
    ok("...while one still paid for counts", quotaFor({ plan: "free", storageAddonGb: 10, storageAddonExpiresAt: new Date(Date.now() + DAY) }) > base);
    // An admin grant with no term is open-ended rather than instantly expired.
    ok("an open-ended grant counts", quotaFor({ plan: "free", storageAddonGb: 10, storageAddonExpiresAt: null }) > base);
    // The permanent per-teacher override is a decision, not a component.
    eq("a permanent override is absolute", quotaFor({ plan: "pro", storageQuotaBytes: 5 * MB, storageAddonGb: 10 }) / MB, 5);

    /*
     * The whole point of the feature: a full free account becomes usable by
     * renting room, without being pushed into a tier it does not need.
     */
    const u = await makeUser("free");
    await addMaterial(u._id, 48 * MB);
    ok("a full free account cannot upload", (await reserveStorage(u, 5 * MB)).ok === false);
    u.storageAddonGb = 5;
    u.storageAddonExpiresAt = new Date(Date.now() + 30 * DAY);
    await u.save();
    const withRoom = await User.findById(u._id);
    ok("...and can once it rents room", (await reserveStorage(withRoom, 5 * MB)).ok === true);
    // And actually uses it, which is what makes the lapse below realistic: the
    // files that put them over the plan limit are the ones the rent paid for.
    await addMaterial(u._id, 5 * MB);

    /*
     * The day it runs out: NOTHING is deleted. The account returns to its plan's
     * allowance, is over quota, and goes read-only for new uploads — the same
     * safe state a plan downgrade produces, which is why non-payment needs no
     * destructive path of its own.
     */
    await User.updateOne({ _id: u._id }, { $set: { storageAddonExpiresAt: new Date(Date.now() - DAY) } });
    const lapsed = await User.findById(u._id);
    const s = await storageStatus(lapsed);
    ok("a lapsed add-on leaves the account full", s.full === true);
    ok("...and refusing new uploads", (await reserveStorage(lapsed, 1 * MB)).ok === false);
    eq("...with every file still there", await Material.countDocuments({ owner: u._id }), 2);
    eq("...and still downloadable, because nothing is deleted for non-payment",
      (await usedBytes(u._id)) / MB, 53);

    // What the teacher is shown: which part is rented, and when it ends.
    await User.updateOne({ _id: u._id }, { $set: { storageAddonExpiresAt: new Date(Date.now() + 10 * DAY) } });
    const live = await storageStatus(await User.findById(u._id));
    ok("the rented part is reported separately", live.addon && live.addon.gb === 5);
    ok("...with the days left, so it cannot lapse as a surprise", live.addon.daysLeft >= 9 && live.addon.daysLeft <= 11);
    ok("an account with no add-on reports none", (await storageStatus(await makeUser("free"))).addon === null);
  }

  /*
   * A deletion must not erase an upload that is still arriving.
   *
   * Both used to live in one counter, so recomputing it after a delete wiped the
   * claim of any upload in flight at that moment — and the account could then be
   * pushed past its limit by the very next request. Committed bytes and in-flight
   * claims are separate fields now, and a delete touches only the first.
   */
  console.log("\n— a delete racing an upload —");
  {
    const u = await makeUser("free");
    const keep = await addMaterial(u._id, 20 * MB);
    const drop = await addMaterial(u._id, 20 * MB);

    const claim = await reserveStorage(u, 9 * MB);
    ok("an upload claims its room", claim.ok === true);

    // A delete lands while those 9MB are still on the wire.
    await Material.deleteOne({ _id: drop._id });
    await recountStorage(u._id);

    const after = await User.findById(u._id).select("storageBytes storageReserved").lean();
    eq("the delete recomputes only what is committed", after.storageBytes / MB, 20);
    eq("...and leaves the in-flight claim standing", after.storageReserved / MB, 9);

    // 20 committed + 9 claimed = 29 of 50; a 25MB file must still not fit.
    const tooBig = await reserveStorage(await User.findById(u._id), 25 * MB);
    ok("the claim still counts against the limit", tooBig.ok === false);
    const fits = await reserveStorage(await User.findById(u._id), 15 * MB);
    ok("...while what genuinely fits is allowed", fits.ok === true);
    void keep;
  }

  /*
   * The claim ends with the response either way.
   *
   * There is no "committed" flag to forget: a successful upload's bytes are in
   * the rows by then, and the rows are what the next reservation reads. The
   * video replacement path stored a file and never set that flag, so a teacher's
   * quota was handed back under a file that existed.
   */
  console.log("\n— a settled claim —");
  {
    const u = await makeUser("free");
    const claim = await reserveStorage(u, 10 * MB);
    ok("room is claimed", claim.ok === true);
    // The upload succeeds: the row appears, then the response ends.
    await addMaterial(u._id, 10 * MB);
    await claim.release();
    const after = await User.findById(u._id).select("storageReserved").lean();
    eq("nothing is left claimed", after.storageReserved, 0);
    // And the bytes are still counted, because they are in the rows now.
    eq("...but the bytes are still counted", (await usedBytes(u._id)) / MB, 10);
    const s2 = await reserveStorage(await User.findById(u._id), 45 * MB);
    ok("so the next upload sees them", s2.ok === false);

    // Releasing twice must not invent free space.
    await claim.release();
    const twice = await User.findById(u._id).select("storageReserved").lean();
    ok("a double release cannot go negative", twice.storageReserved >= 0);
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
