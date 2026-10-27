const express = require("express");
const { protect, teacherOnly, adminOnly } = require("../middleware/authMiddleware");
const controller = require("../controllers/stripeBillingController");

const router = express.Router();
// Admin: who opened the card page, is on the trial, pays, owes (before the
// teacher-only guard below, which an admin would not pass).
router.get("/admin/teachers", protect, adminOnly, controller.adminCardTeachers);

router.use(protect, teacherOnly);
router.get("/status", controller.billingStatus);
router.post("/checkout", controller.createCheckout);
router.post("/addon", controller.createAddonCheckout);
router.post("/portal", controller.createPortal);
router.post("/pay-due", controller.payDue);
router.post("/pay-due/complete", controller.completeDue);

module.exports = router;
