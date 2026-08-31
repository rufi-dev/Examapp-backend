const express = require("express");
const router = express.Router();
const { protect, parentOnly, teacherOnly } = require("../middleware/authMiddleware");
const { getParentLive } = require("../controllers/quizController");
const {
  linkChild,
  linkChildByEmail,
  listChildren,
  unlinkChild,
  childResults,
  childHomework,
  childAttendance,
  childPayments,
  allResults,
  allHomework,
  allAttendance,
  teacherStudents,
  decideParentLink,
  myParentRequests,
  myParents,
  decideMyParentLink,
  createParentAccount,
  managedParents,
  setParentNotify,
  setManagedPassword,
} = require("../controllers/parentController");

// ── Parent portal (parentOnly) ──
router.post("/link", protect, parentOnly, linkChild); // by code (instant)
router.post("/link-email", protect, parentOnly, linkChildByEmail); // by email (pending)
router.get("/children", protect, parentOnly, listChildren);
router.get("/live", protect, parentOnly, getParentLive); // children taking an exam now (teacher-grade telemetry, child-scoped)
// Aggregated feeds across all children (newest first).
router.get("/results", protect, parentOnly, allResults);
router.get("/homework", protect, parentOnly, allHomework);
router.get("/attendance", protect, parentOnly, allAttendance);
router.delete("/children/:childId", protect, parentOnly, unlinkChild);
router.get("/children/:childId/results", protect, parentOnly, childResults);
router.get("/children/:childId/homework", protect, parentOnly, childHomework);
router.get("/children/:childId/attendance", protect, parentOnly, childAttendance);
router.get("/children/:childId/payments", protect, parentOnly, childPayments);

// ── Teacher management of parent↔student links (teacherOnly) ──
// ── Managed parent accounts ─────────────────────────────────────────────────────
// `protect` only: a STUDENT may create a parent for themselves and see/manage that
// parent. The controller decides what each role may touch — a student can never
// reach beyond their own account, a teacher never beyond their own students.
router.post("/accounts", protect, createParentAccount);
router.get("/managed", protect, managedParents);
router.patch("/managed/:parentId/notify", protect, setParentNotify);
router.patch("/managed/:userId/password", protect, setManagedPassword);

router.get("/teacher/students", protect, teacherOnly, teacherStudents);
router.patch("/teacher/link/:linkId", protect, teacherOnly, decideParentLink);

// ── Student approves/rejects a pending parent request (any signed-in student) ──
router.get("/student/requests", protect, myParentRequests);
router.get("/student/parents", protect, myParents);
router.patch("/student/link/:linkId", protect, decideMyParentLink); // approve | reject (also removes an approved parent)

module.exports = router;
