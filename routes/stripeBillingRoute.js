const express = require("express");
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const controller = require("../controllers/stripeBillingController");

const router = express.Router();
router.use(protect, teacherOnly);
router.get("/status", controller.billingStatus);
router.post("/checkout", controller.createCheckout);
router.post("/portal", controller.createPortal);

module.exports = router;
