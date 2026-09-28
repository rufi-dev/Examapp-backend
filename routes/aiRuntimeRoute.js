const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const controller = require("../controllers/aiRuntimeController");

const router = express.Router();
router.use(protect, adminOnly);
router.get("/", controller.get);
router.patch("/", controller.update);
/* Forget a CLI's remembered cooldown and let the next request find out. */
router.post("/cli/:provider/reset", controller.resetProvider);
/* Actually spend one tiny turn to find out whether the plan has room. */
router.post("/cli/:provider/check", controller.checkProvider);

module.exports = router;
