const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const controller = require("../controllers/aiRuntimeController");

const router = express.Router();
router.use(protect, adminOnly);
router.get("/", controller.get);
router.patch("/", controller.update);
/* Forget a CLI's remembered cooldown and let the next request find out. */
router.post("/cli/:provider/reset", controller.resetProvider);

module.exports = router;
