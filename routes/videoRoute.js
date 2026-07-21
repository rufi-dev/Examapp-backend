const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  getVideos,
  addVideo,
  updateVideo,
  deleteVideo,
} = require("../controllers/videoController");

// Any signed-in user can watch (list is scoped per-role in the controller);
// only teachers/admins add or delete (delete gated to owner/admin).
router.get("/", protect, getVideos);
router.post("/", protect, teacherOnly, addVideo);
router.patch("/:id", protect, teacherOnly, updateVideo);
router.delete("/:id", protect, teacherOnly, deleteVideo);

module.exports = router;
