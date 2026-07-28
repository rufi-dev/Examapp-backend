/*
 * Teacher Success Journey — capability decomposition unit tests (ADR §4).
 * Pure (no DB). Proves: safe own-scope auto-grant for a new Spark teacher when
 * the Journey is on; risky/admin stay gated; growth level is NEVER consulted;
 * flag-off preserves today's behavior; client cannot forge capability.
 */
const caps = require("../helper/teacherCapabilities");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const has = (user, cap, journeyEnabled) => caps.capabilitiesFor(user, { journeyEnabled }).has(cap);

const admin = { role: "admin" };
const pendingTeacher = { role: "teacher", teacherApproval: "pending" };
const noneTeacher = { role: "teacher", teacherApproval: "none" };
const approvedTeacher = { role: "teacher", teacherApproval: "approved" };
const legacyTeacher = { role: "teacher", teacherApproval: "approved_legacy" };
const student = { role: "student" };

// ── Journey ON: a new Spark teacher gets safe own-scope immediately ──
ok("Spark(pending) can create own exam (journey on)", has(pendingTeacher, "exam:create:own", true));
ok("Spark(pending) can publish own exam (journey on)", has(pendingTeacher, "exam:publish:own", true));
ok("Spark(pending) can manage own classes (journey on)", has(pendingTeacher, "class:manage:own", true));
ok("Spark(pending) can view own results (journey on)", has(pendingTeacher, "results:view:own", true));
ok("Spark(none) also gets own-scope (journey on)", has(noneTeacher, "exam:create:own", true));

// ── Journey ON: risky/admin stay gated for a new Spark teacher ──
ok("Spark(pending) CANNOT bulk-invite (journey on)", !has(pendingTeacher, "invite:bulk", true));
ok("Spark(pending) CANNOT bulk-message (journey on)", !has(pendingTeacher, "messaging:bulk", true));
ok("Spark(pending) CANNOT export students in bulk (journey on)", !has(pendingTeacher, "export:students:bulk", true));
ok("Spark(pending) CANNOT access other-owner data (journey on)", !has(pendingTeacher, "data:access:other-owner", true));
ok("Spark(pending) CANNOT global-mutate (journey on)", !has(pendingTeacher, "mutation:global", true));
ok("Spark(pending) CANNOT admin (journey on)", !has(pendingTeacher, "admin", true));

// ── Approved teacher: own-scope + gated teacher, never admin ──
ok("approved teacher has own-scope", has(approvedTeacher, "exam:create:own", false));
ok("approved teacher has gated-teacher (bulk invite)", has(approvedTeacher, "invite:bulk", false));
ok("approved teacher does NOT have admin", !has(approvedTeacher, "admin", false));
ok("approved teacher does NOT have other-owner access", !has(approvedTeacher, "data:access:other-owner", false));
ok("approved_legacy teacher has own-scope", has(legacyTeacher, "exam:create:own", false));

// ── Admin: everything ──
ok("admin has admin", has(admin, "admin", false));
ok("admin has other-owner access", has(admin, "data:access:other-owner", false));
ok("admin has own-scope", has(admin, "exam:create:own", false));

// ── Student / anonymous: nothing ──
ok("student has no teacher capability", caps.capabilitiesFor(student, { journeyEnabled: true }).size === 0);
ok("anonymous has no capability", caps.capabilitiesFor(null, { journeyEnabled: true }).size === 0);

// ── Flag OFF preserves today's behavior ──
ok("Spark(pending) gets NOTHING when journey off (unchanged)", caps.capabilitiesFor(pendingTeacher, { journeyEnabled: false }).size === 0);
ok("approved teacher unchanged when journey off", has(approvedTeacher, "exam:create:own", false) && has(approvedTeacher, "invite:bulk", false));
ok("admin unchanged when journey off", has(admin, "admin", false));

// ── Growth level is NEVER consulted (D10): forging teacherLevel grants nothing ──
ok("forged teacherLevel=impact on a student grants nothing", caps.capabilitiesFor({ role: "student", teacherLevel: "impact" }, { journeyEnabled: true }).size === 0);
ok("forged teacherLevel=impact does not grant admin to a teacher", !has({ role: "teacher", teacherApproval: "pending", teacherLevel: "impact" }, "admin", true));
ok("forged teacherLevel does not add gated-teacher to a pending teacher", !has({ role: "teacher", teacherApproval: "pending", teacherLevel: "impact" }, "invite:bulk", true));

// ── Catalog integrity ──
ok("own-scope/gated/admin are disjoint", (() => {
  const all = [...caps.OWN_SCOPE, ...caps.GATED_TEACHER, ...caps.ADMIN];
  return new Set(all).size === all.length;
})());
ok("requireCapability rejects an unknown capability", (() => { try { caps.requireCapability("exam:teleport"); return false; } catch { return true; } })());
ok("requireCapability returns middleware for a real capability", typeof caps.requireCapability("exam:create:own") === "function");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
