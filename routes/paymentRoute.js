const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { createPayment, listPayments, updatePayment, deletePayment } = require("../controllers/paymentController");

router.post("/", protect, teacherOnly, createPayment);
router.get("/", protect, teacherOnly, listPayments);
router.patch("/:id", protect, teacherOnly, updatePayment);
router.delete("/:id", protect, teacherOnly, deletePayment);

module.exports = router;
