const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  createLesson,
  listLessons,
  getLesson,
  updateLesson,
  deleteLesson,
  toggleAttendance,
  markAttendance,
  checkin,
  myLessons,
} = require("../controllers/lessonController");

// Student self-check-in by QR code. Declared before "/:id" so "checkin" isn't an id.
router.post("/checkin/:code", protect, checkin);
// A student's own lessons + attendance (declared before "/:id").
router.get("/my", protect, myLessons);

// Teacher lesson calendar CRUD.
router.post("/", protect, teacherOnly, createLesson);
router.get("/", protect, teacherOnly, listLessons);
router.get("/:id", protect, teacherOnly, getLesson);
router.patch("/:id", protect, teacherOnly, updateLesson);
router.delete("/:id", protect, teacherOnly, deleteLesson);

// Attendance management for one lesson.
router.post("/:id/attendance/open", protect, teacherOnly, toggleAttendance);
router.post("/:id/attendance/mark", protect, teacherOnly, markAttendance);

module.exports = router;
