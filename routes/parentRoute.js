const express = require("express");
const router = express.Router();
const { protect, parentOnly, teacherOnly } = require("../middleware/authMiddleware");
const {
  linkChild,
  linkChildByEmail,
  listChildren,
  unlinkChild,
  childResults,
  childHomework,
  childAttendance,
  childPayments,
  teacherStudents,
  decideParentLink,
  myParentRequests,
  decideMyParentLink,
} = require("../controllers/parentController");

// ── Parent portal (parentOnly) ──
router.post("/link", protect, parentOnly, linkChild); // by code (instant)
router.post("/link-email", protect, parentOnly, linkChildByEmail); // by email (pending)
router.get("/children", protect, parentOnly, listChildren);
router.delete("/children/:childId", protect, parentOnly, unlinkChild);
router.get("/children/:childId/results", protect, parentOnly, childResults);
router.get("/children/:childId/homework", protect, parentOnly, childHomework);
router.get("/children/:childId/attendance", protect, parentOnly, childAttendance);
router.get("/children/:childId/payments", protect, parentOnly, childPayments);

// ── Teacher management of parent↔student links (teacherOnly) ──
router.get("/teacher/students", protect, teacherOnly, teacherStudents);
router.patch("/teacher/link/:linkId", protect, teacherOnly, decideParentLink);

// ── Student approves/rejects a pending parent request (any signed-in student) ──
router.get("/student/requests", protect, myParentRequests);
router.patch("/student/link/:linkId", protect, decideMyParentLink);

module.exports = router;
