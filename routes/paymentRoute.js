const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const {
  createPayment,
  listPayments,
  updatePayment,
  deletePayment,
  myPayments,
  upsertRecurring,
  listRecurring,
  updateRecurring,
  deleteRecurring,
} = require("../controllers/paymentController");

// A student's own payments (declared before "/:id" routes).
router.get("/my", protect, myPayments);

// Recurring monthly plans (teacher). Declared before "/:id" so "recurring" isn't an id.
router.get("/recurring", protect, teacherOnly, listRecurring);
router.post("/recurring", protect, teacherOnly, upsertRecurring);
router.patch("/recurring/:id", protect, teacherOnly, updateRecurring);
router.delete("/recurring/:id", protect, teacherOnly, deleteRecurring);

router.post("/", protect, teacherOnly, createPayment);
router.get("/", protect, teacherOnly, listPayments);
router.patch("/:id", protect, teacherOnly, updatePayment);
router.delete("/:id", protect, teacherOnly, deletePayment);

module.exports = router;
