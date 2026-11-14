const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  getVideos,
  getPublicVideos,
  addVideo,
  deleteVideo,
} = require("../controllers/videoController");

// Home page (no sign-in): the newest 6 as cards; watching asks to sign in.
router.get("/public", getPublicVideos);
// Everyone signed in can watch; only teachers/admins add or delete.
router.get("/", protect, getVideos);
router.post("/", protect, teacherOnly, addVideo);
router.delete("/:id", protect, teacherOnly, deleteVideo);

module.exports = router;
