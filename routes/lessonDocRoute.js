const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const c = require("../controllers/lessonDocController");

// Teacher surface: a student has nothing to do here, and the AI turn costs money.
router.use(protect, teacherOnly);

router.get("/", c.listDocs);
router.post("/", c.createDoc);
router.get("/:id", c.getDoc);
router.patch("/:id", c.updateDoc);
router.delete("/:id", c.removeDoc);
router.post("/:id/message", c.sendMessage);
router.get("/:id/export", c.exportDoc);

module.exports = router;
