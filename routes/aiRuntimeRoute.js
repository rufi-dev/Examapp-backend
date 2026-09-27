const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const controller = require("../controllers/aiRuntimeController");

const router = express.Router();
router.use(protect, adminOnly);
router.get("/", controller.get);
router.patch("/", controller.update);

module.exports = router;
