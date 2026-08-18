const express = require("express");
const {
  getPaymentInfo,
  createRequest,
  listRequests,
  decideRequest,
} = require("../controllers/examPaymentController");
const { protect, teacherOnly, verifiedOnly } = require("../middleware/authMiddleware");
const router = express.Router();

// Student side
router.get("/payment-info", protect, getPaymentInfo);
router.post("/request", protect, verifiedOnly, createRequest); // "Ödədim"

// Admin + teacher side (teacherOnly allows admin & teacher; controller scopes teachers to their own exams)
router.get("/requests", protect, teacherOnly, listRequests);
router.patch("/requests/:id", protect, teacherOnly, decideRequest);

module.exports = router;
