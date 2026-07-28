/*
 * AUD-005 (CR-042) — the SINGLE server-authoritative decision for a user's role +
 * teacher capability on an ADMIN transition. Both upgradeUser (single) and
 * bulkUsers (batch) resolve through here so `role` and `teacherApproval` can never
 * drift apart across paths.
 *
 * Invariant enforced here:
 *   - non-teacher role            → teacherApproval "none", meta cleared
 *   - admin promotes to teacher   → teacherApproval "approved" (+ admin provenance)
 *   - admin holds a teacher       → teacherApproval "pending" (no grant provenance)
 *   - "approved_legacy" is MIGRATION-OWNED — it can NEVER be produced by an admin
 *     API call, only by the grandfather migration. Any attempt to set it here is
 *     downgraded to "approved" (an explicit admin grant), so rollback/audit can
 *     always distinguish a migration grant from an admin one.
 */

// The only teacher states an admin transition may assign. NOT approved_legacy.
const ADMIN_ASSIGNABLE = new Set(["approved", "pending"]);

// Resolve the { role, teacherApproval, teacherApprovalMeta } an admin transition
// must persist. `desiredApproval` is an optional admin override (approve vs hold);
// anything outside ADMIN_ASSIGNABLE collapses to "approved" for a teacher.
function resolveAdminCapability({ role, desiredApproval, actorId, now }) {
  if (role !== "teacher") {
    return { role, teacherApproval: "none", teacherApprovalMeta: null };
  }
  const state = ADMIN_ASSIGNABLE.has(desiredApproval) ? desiredApproval : "approved";
  const meta =
    state === "approved"
      ? { by: actorId || null, at: now || new Date(), method: "admin", batch: null }
      : null; // "pending" is a hold, not a grant — carries no provenance
  return { role: "teacher", teacherApproval: state, teacherApprovalMeta: meta };
}

// A dedicated approve/revoke transition on an account that is ALREADY a teacher
// (role unchanged). Used by the admin directory's explicit actions.
//   approve → "approved" (+ provenance);  revoke → "pending" (held, non-capable).
function resolveApprovalAction({ approve, actorId, now }) {
  return approve
    ? { teacherApproval: "approved", teacherApprovalMeta: { by: actorId || null, at: now || new Date(), method: "admin", batch: null } }
    : { teacherApproval: "pending", teacherApprovalMeta: null };
}

// AUD-005 (CR-046): the SELF-SERVICE transition (registration / onboarding role
// choice). Records the REQUEST only — a chosen teacher is created "pending" (no
// capability) with method "self"; anything else is a plain non-teacher. Returns a
// full triple so callers ALWAYS set role + teacherApproval + teacherApprovalMeta
// atomically (clearing any stale admin/migration provenance).
function resolveSelfServiceCapability({ role, now }) {
  if (role !== "teacher") {
    return { role, teacherApproval: "none", teacherApprovalMeta: null };
  }
  // Auto-approval: a self-registering teacher is granted capability immediately
  // (method "self"), so they can create their own classes/exams right after sign-up
  // without waiting for an admin. The approval SYSTEM is unchanged — an admin can
  // still suspend/re-approve — only the default starting state for a self-registrant
  // moves from "pending" to "approved".
  return {
    role: "teacher",
    teacherApproval: "approved",
    teacherApprovalMeta: { by: null, at: now || new Date(), method: "self", batch: null },
  };
}

// Server-derived capability check, shared with the middleware's gate. A teacher is
// capable only when approved / approved_legacy; every other state is non-capable.
const CAPABLE_TEACHER = new Set(["approved", "approved_legacy"]);
function hasTeacherCapability(user) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return user.role === "teacher" && CAPABLE_TEACHER.has(user.teacherApproval);
}

module.exports = { resolveAdminCapability, resolveApprovalAction, resolveSelfServiceCapability, hasTeacherCapability, ADMIN_ASSIGNABLE };
