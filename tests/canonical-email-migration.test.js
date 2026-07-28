/*
 * AUD-008 CR-050 — canonical-email migration lifecycle: dry-run reports collisions
 * read-only → apply REFUSES while a collision exists → apply lower-cases once
 * resolved → rollback is a documented no-op.
 */
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

mongoose.set("autoIndex", false);
const BE = path.join(__dirname, "..");
const MIG = "migrations/2026-07-26-canonical-email.js";
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function run(uri, args) {
  try { return { code: 0, out: execFileSync("node", [MIG, ...args], { cwd: BE, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8" }) }; }
  catch (e) { return { code: e.status == null ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") }; }
}

async function main() {
  const mem = await MongoMemoryServer.create();
  const host = mem.getUri().replace(/\/?$/, "/");
  const DB = "exq_e2e_test";
  const uri = host + DB;
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const users = db.collection("users");
  const oid = () => new mongoose.Types.ObjectId();
  const mk = (email) => ({ _id: oid(), name: "U", email, password: "x", role: "student", createdAt: new Date() });
  await users.insertMany([
    mk("Alice@X.com"),   // needs lowercasing
    mk("bob@x.com"),     // already canonical
    mk("Dup@x.com"),     // collision pair...
    mk("dup@x.com"),     // ...same canonical as above
  ]);
  const emailsNow = async () => (await users.find({}, { projection: { email: 1 } }).toArray()).map((u) => u.email).sort();

  // ── dry-run reports the collision + read-only ──
  const before = await emailsNow();
  const dry = run(uri, ["--dry-run", "--db=" + DB]);
  ok("dry-run exits 0", dry.code === 0);
  ok("dry-run reports 1 collision group", /collision groups=1/.test(dry.out));
  ok("dry-run reports need-lowercasing", /need-lowercasing=/.test(dry.out) && /READ ONLY/.test(dry.out));
  ok("dry-run changed nothing", JSON.stringify(await emailsNow()) === JSON.stringify(before));

  // ── apply REFUSES while a collision exists ──
  const refused = run(uri, ["--apply", "--db=" + DB]);
  ok("apply refused on collision (exit 4)", refused.code === 4);
  ok("refused apply changed nothing", JSON.stringify(await emailsNow()) === JSON.stringify(before));

  // ── CR-058: resolve the collision, apply lower-cases AND creates+verifies the
  //    unique index (fresh collection had NO email index) ──
  await users.deleteOne({ email: "Dup@x.com" });
  const { inspectEmailIndex, verifyEmailUniqueIndex } = require("../helper/emailIndex");
  ok("before apply: NO unique email index", (await inspectEmailIndex(db)).state === "absent");
  const apply = run(uri, ["--apply", "--db=" + DB]);
  ok("apply exits 0 after resolving the collision", apply.code === 0);
  ok("Alice@X.com was lower-cased", !!(await users.findOne({ email: "alice@x.com" })) && !(await users.findOne({ email: "Alice@X.com" })));
  ok("CR-058: apply CREATED an exact unique {email:1} index", (await verifyEmailUniqueIndex(db)).ok === true);
  ok("apply reports the uniqueness invariant verified", /exact uniqueness invariant = true/.test(apply.out));

  // ── idempotent re-apply ──
  const again = run(uri, ["--apply", "--db=" + DB]);
  ok("re-apply exits 0, lower-cases 0, still verified", again.code === 0 && /lower-cased 0 email/.test(again.out) && /invariant = true/.test(again.out));

  // ── CR-058: concurrent case-variant inserts are now blocked by the unique index ──
  let dupBlocked = false;
  try { await users.insertOne({ _id: oid(), name: "X", email: "alice@x.com", role: "student" }); }
  catch (e) { dupBlocked = e && (e.code === 11000 || /duplicate key/i.test(e.message)); }
  ok("a second alice@x.com is rejected by the unique index", dupBlocked);

  // ── CR-058: startup verifier throws when the unique index is absent ──
  const FRESH = "exq_noidx_test";
  const freshDb = mongoose.connection.useDb(FRESH).db;
  await freshDb.collection("users").insertOne({ _id: oid(), name: "N", email: "n@x.com" });
  let vThrew = false;
  try { await require("../helper/emailIndex").assertEmailUniqueIndex(freshDb); }
  catch (e) { vThrew = /canonical-email/.test(e.message); }
  ok("startup verifier throws (naming the migration) when the index is absent", vThrew);

  // ── CR-058: a WRONG-shape (non-unique) email index is refused, then replaced ──
  const WD = "exq_wrongidx_test";
  const wUri = host + WD;
  const wDb = mongoose.connection.useDb(WD).db;
  await wDb.collection("users").insertOne({ _id: oid(), name: "W", email: "w@x.com" });
  await wDb.collection("users").createIndex({ email: 1 }); // NON-unique
  const refuseWrong = run(wUri, ["--apply", "--db=" + WD]);
  ok("apply REFUSES a non-unique email index (exit 4)", refuseWrong.code === 4);
  ok("still non-unique after the refusal", (await inspectEmailIndex(wDb)).state === "wrong_shape");
  const replaced = run(wUri, ["--apply", "--db=" + WD, "--replace-index"]);
  ok("--replace-index recreates it UNIQUE (exit 0)", replaced.code === 0 && (await verifyEmailUniqueIndex(wDb)).ok === true);

  // ── CR-062: partial/sparse/collation "unique" indexes are wrong_shape and are
  //    refused WITHOUT mutating emails; --replace-index fixes each. ──
  const { inspectEmailIndex: inspect2 } = require("../helper/emailIndex");
  const adversarial = [
    { db: "exq_partial_test", make: (c) => c.createIndex({ email: 1 }, { unique: true, name: "email_1", partialFilterExpression: { email: { $gt: "" } } }), reason: "partial" },
    { db: "exq_sparse_test", make: (c) => c.createIndex({ email: 1 }, { unique: true, name: "email_1", sparse: true }), reason: "sparse" },
    { db: "exq_collation_test", make: (c) => c.createIndex({ email: 1 }, { unique: true, name: "email_1", collation: { locale: "en", strength: 2 } }), reason: "collation" },
  ];
  for (const a of adversarial) {
    const aUri = host + a.db;
    const aDb = mongoose.connection.useDb(a.db).db;
    await aDb.collection("users").insertOne({ _id: oid(), name: "M", email: "Mixed@X.com" });
    await a.make(aDb.collection("users"));
    const insp = await inspect2(aDb);
    ok(`${a.reason} unique index is wrong_shape (verify NOT ok)`, insp.state === "wrong_shape" && insp.reasons.includes(a.reason));
    const refuse = run(aUri, ["--apply", "--db=" + a.db]);
    ok(`${a.reason}: apply REFUSES (exit 4)`, refuse.code === 4);
    ok(`${a.reason}: NO email was mutated before the refusal`, !!(await aDb.collection("users").findOne({ email: "Mixed@X.com" })));
    const fix = run(aUri, ["--apply", "--db=" + a.db, "--replace-index"]);
    ok(`${a.reason}: --replace-index makes it EXACT (exit 0)`, fix.code === 0 && (await verifyEmailUniqueIndex(aDb)).ok === true);
    ok(`${a.reason}: email is now canonical after replacement`, !!(await aDb.collection("users").findOne({ email: "mixed@x.com" })));
  }

  // ── CR-062: the APPLICATION (require User + connect + write) must NOT create
  //    email_1 — autoIndex:false + autoCreate:false. ──
  {
    const appDb = "exq_appnoidx_test";
    const appConn = await mongoose.createConnection(host + appDb).asPromise();
    const UserModel = appConn.model("User", require("../models/userModel").schema);
    await UserModel.create({ name: "A", email: "App@X.com", password: "xxxxxxxx", phone: "+99450", role: "student", userAgent: [] });
    const names = (await appConn.db.collection("users").indexes()).map((i) => i.name);
    ok("CR-062: app write did NOT auto-create email_1 (migration-owned)", !names.includes("email_1"));
    ok("CR-062: app stored the email canonically (lowercase:true setter)", !!(await appConn.db.collection("users").findOne({ email: "app@x.com" })));
    await appConn.close();
  }

  // ── rollback no-op (keeps the unique index) ──
  const rb = run(uri, ["--rollback", "--db=" + DB]);
  ok("rollback exits 0 (documented no-op)", rb.code === 0 && /no-op by design/.test(rb.out));
  ok("rollback did NOT drop the unique index", (await verifyEmailUniqueIndex(db)).ok === true);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
