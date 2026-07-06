const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  getVideos,
  addVideo,
  deleteVideo,
} = require("../controllers/videoController");

// Everyone signed in can watch; only teachers/admins add or delete.
router.get("/", protect, getVideos);
router.post("/", protect, teacherOnly, addVideo);
router.delete("/:id", protect, teacherOnly, deleteVideo);

module.exports = router;
