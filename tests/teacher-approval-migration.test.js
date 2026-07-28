/*
 * AUD-005 migration lifecycle (in-memory Mongo, real child-process runs).
 * CR-041 (reviewed allowlist, fail-closed hold, reversible batch), CR-043
 * (dry-run truly read-only), CR-045 (safe CLI contract: exactly-one mode,
 * exactly-one decision source, persisted reviewer identity, required rollback
 * batch, unmatched-ID reporting).
 */
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../models/userModel");
const { hasTeacherCapability } = require("../middleware/authMiddleware");

const BE = path.join(__dirname, "..");
const MIG = "migrations/2026-07-26-teacher-approval.js";
let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function run(uri, args) {
  try {
    return { code: 0, out: execFileSync("node", [MIG, ...args], { cwd: BE, env: { ...process.env, MONGO_URI: uri }, encoding: "utf8" }) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: (e.stdout || "") + (e.stderr || "") };
  }
}
const doc = async (id) => User.findById(id).lean();
const approvalOf = async (id) => (await doc(id)).teacherApproval;

async function main() {
  const mem = await MongoMemoryServer.create();
  const host = mem.getUri().replace(/\/?$/, "/");
  const TEST_DB = "exq_e2e_test";
  const PROD_DB = "examopia_prod";
  const FRESH_DB = "exq_fresh_test";
  const testUri = host + TEST_DB;
  const prodUri = host + PROD_DB;
  const freshUri = host + FRESH_DB;

  await mongoose.connect(testUri);

  const admin = await User.create({ name: "Ad", email: "admin@e.com", password: "xxxxxxxx", role: "admin" });
  const legit = await User.create({ name: "L", email: "legit@e.com", password: "xxxxxxxx", role: "teacher" });
  await User.collection.updateOne({ _id: legit._id }, { $unset: { teacherApproval: "" } });
  const attacker = await User.create({ name: "X", email: "attacker@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "none" });
  const selfPending = await User.create({ name: "P", email: "selfpending@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "pending" });
  const approved = await User.create({ name: "A", email: "approved@e.com", password: "xxxxxxxx", role: "teacher", teacherApproval: "approved", teacherApprovalMeta: { method: "admin", at: new Date() } });
  const student = await User.create({ name: "S", email: "student@e.com", password: "xxxxxxxx", role: "student" });
  const A = (x) => "--allow=" + String(x);
  const R = "--reviewer=" + String(admin._id);

  // ── 1) DRY RUN read-only + reports the legacy set ──
  const dry = run(testUri, ["--dry-run", "--db=" + TEST_DB]);
  ok("dry-run exits 0", dry.code === 0);
  ok("dry-run reports READ ONLY", /READ ONLY/i.test(dry.out));
  ok("dry-run lists both legacy teachers", /legit@e\.com/.test(dry.out) && /attacker@e\.com/.test(dry.out));
  ok("dry-run wrote NOTHING (legit still unset)", (await approvalOf(legit._id)) === undefined);

  // ── 1b) CR-043: dry-run on a FRESH DB creates NO collection ──
  const fresh = await mongoose.createConnection(freshUri).asPromise();
  const before = (await fresh.db.listCollections().toArray()).map((c) => c.name).sort();
  const dryFresh = run(freshUri, ["--dry-run", "--db=" + FRESH_DB]);
  const after = (await fresh.db.listCollections().toArray()).map((c) => c.name).sort();
  ok("fresh-DB dry-run exits 0", dryFresh.code === 0);
  ok("fresh-DB collection set unchanged (no users created)", JSON.stringify(before) === JSON.stringify(after) && !after.includes("users"));
  await fresh.close();

  // ── 2) CR-045.1: contradictory MODES are rejected (never resolved by precedence) ──
  const conflictMode = run(testUri, ["--apply", "--rollback", "--db=" + TEST_DB, "--batch=b1"]);
  ok("--apply + --rollback refused (exit 2)", conflictMode.code === 2);
  ok("contradictory-mode run mutated nothing", (await approvalOf(legit._id)) === undefined);

  // ── 2b) CR-045.2: the reproduced defect — --allow-none + --allow can't co-exist ──
  const conflictDecision = run(testUri, ["--apply", "--db=" + TEST_DB, "--allow-none", A(legit._id), R]);
  ok("--allow-none + --allow refused (exit 4)", conflictDecision.code === 4);
  ok("conflicting-decision run did NOT grant the allowlisted account", (await approvalOf(legit._id)) === undefined);

  // ── 3) FAIL-CLOSED on a non-throwaway name ──
  const blocked = run(prodUri, ["--apply", "--allow-none"]);
  ok("apply on non-throwaway NAME refused (exit 3)", blocked.code === 3);

  // ── 3b) apply with NO decision source refused ──
  const noDecision = run(testUri, ["--apply", "--db=" + TEST_DB]);
  ok("apply without a decision source refused (exit 4)", noDecision.code === 4);

  // ── 4) CR-045.3: granting REQUIRES a valid, existing admin reviewer ──
  const noReviewer = run(testUri, ["--apply", "--db=" + TEST_DB, A(legit._id)]);
  ok("granting without --reviewer refused (exit 4)", noReviewer.code === 4);
  const badReviewer = run(testUri, ["--apply", "--db=" + TEST_DB, A(legit._id), "--reviewer=" + String(student._id)]);
  ok("granting with a NON-admin reviewer refused (exit 4)", badReviewer.code === 4);
  ok("no grant happened on the refused reviewer runs", (await approvalOf(legit._id)) === undefined);

  // ── 5) APPLY with a reviewed allowlist + valid reviewer + unmatched-ID report ──
  const strayId = String(new mongoose.Types.ObjectId()); // not a legacy teacher
  const apply = run(testUri, ["--apply", "--db=" + TEST_DB, "--allow=" + [legit._id, strayId].join(","), R, "--batch=b1"]);
  ok("apply exits 0", apply.code === 0);
  ok("apply grandfathered exactly 1 reviewed teacher", /grandfathered 1 reviewed/.test(apply.out));
  ok("apply held 1 unreviewed teacher → pending", /held 1 unreviewed/.test(apply.out));
  ok("CR-045.5: stray reviewed ID is reported as unmatched", /did NOT match/.test(apply.out) && apply.out.includes(strayId));

  const legitDoc = await doc(legit._id);
  ok("reviewed legit teacher → approved_legacy (CAPABLE)", legitDoc.teacherApproval === "approved_legacy" && hasTeacherCapability(legitDoc));
  ok("CR-045.3: reviewer identity persisted (meta.by === admin id)", legitDoc.teacherApprovalMeta && String(legitDoc.teacherApprovalMeta.by) === String(admin._id) && legitDoc.teacherApprovalMeta.method === "migration" && legitDoc.teacherApprovalMeta.batch === "b1");
  const attackerDoc = await doc(attacker._id);
  ok("attacker-shaped teacher → pending (NOT capable), by=null", attackerDoc.teacherApproval === "pending" && !hasTeacherCapability(attackerDoc) && attackerDoc.teacherApprovalMeta.by == null);
  ok("self-pending untouched", (await approvalOf(selfPending._id)) === "pending");
  ok("admin-approved teacher preserved", (await approvalOf(approved._id)) === "approved");
  ok("student untouched", (await approvalOf(student._id)) === "none");

  // ── 6) IDEMPOTENT re-apply ──
  const again = run(testUri, ["--apply", "--db=" + TEST_DB, A(legit._id), R, "--batch=b1"]);
  ok("re-apply grandfathers 0 and holds 0 (idempotent)", /grandfathered 0 reviewed/.test(again.out) && /held 0 unreviewed/.test(again.out));

  // ── 7) CR-045.4: rollback requires an explicit --batch; wrong batch reverts 0 ──
  const noBatch = run(testUri, ["--rollback", "--db=" + TEST_DB]);
  ok("rollback without --batch refused (exit 4)", noBatch.code === 4);
  const wrongBatch = run(testUri, ["--rollback", "--db=" + TEST_DB, "--batch=nope"]);
  ok("rollback with the WRONG batch reverts 0 (fail-safe)", /reverted 0 migration-owned/.test(wrongBatch.out));
  ok("legit still approved_legacy after wrong-batch rollback", (await approvalOf(legit._id)) === "approved_legacy");

  // ── 8) ROLLBACK with the exact batch reverts only this migration's own rows ──
  const rb = run(testUri, ["--rollback", "--db=" + TEST_DB, "--batch=b1"]);
  ok("rollback exits 0", rb.code === 0);
  ok("rollback reverted 2 migration-owned (grant + hold)", /reverted 2 migration-owned/.test(rb.out));
  ok("legit reverted to none", (await approvalOf(legit._id)) === "none");
  ok("attacker reverted to none", (await approvalOf(attacker._id)) === "none");
  ok("self-pending PRESERVED (not migration-owned)", (await approvalOf(selfPending._id)) === "pending");
  ok("admin-approved PRESERVED", (await approvalOf(approved._id)) === "approved");

  // ── 9) --allow-none grandfathers NOBODY (all legacy → pending) ──
  const allowNone = run(testUri, ["--apply", "--db=" + TEST_DB, "--allow-none", "--batch=b2"]);
  ok("--allow-none grandfathers 0", /grandfathered 0 reviewed/.test(allowNone.out));
  ok("--allow-none holds both legacy → pending", (await approvalOf(legit._id)) === "pending" && (await approvalOf(attacker._id)) === "pending");

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
