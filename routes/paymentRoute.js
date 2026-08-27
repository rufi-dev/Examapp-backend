const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { createPayment, listPayments, updatePayment, deletePayment, myPayments } = require("../controllers/paymentController");

// A student's own payments (declared before "/:id" routes).
router.get("/my", protect, myPayments);
router.post("/", protect, teacherOnly, createPayment);
router.get("/", protect, teacherOnly, listPayments);
router.patch("/:id", protect, teacherOnly, updatePayment);
router.delete("/:id", protect, teacherOnly, deletePayment);

module.exports = router;
