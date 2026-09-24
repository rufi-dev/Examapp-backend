const express = require("express");
const router = express.Router();
const { protect, teacherOnly, adminOnly } = require("../middleware/authMiddleware");
const {
  getCatalog,
  getPaymentInfo,
  requestUpgrade,
  requestCredit,
  requestStorage,
  listSubscribers,
  listDowngraded,
  listCredited,
  listUpgradeRequests,
  decideUpgradeRequest,
} = require("../controllers/planController");

// Public pricing catalog (drives the /pricing page).
router.get("/catalog", getCatalog);

// Card details to transfer to (auth-gated). Teacher-initiated upgrade request.
router.get("/payment-info", protect, teacherOnly, getPaymentInfo);
router.post("/upgrade-request", protect, teacherOnly, requestUpgrade);
router.post("/credit-request", protect, teacherOnly, requestCredit);
// Extra storage without changing plan. Records a demand; grants nothing.
router.post("/storage-request", protect, teacherOnly, requestStorage);

// Admin package control + inbox + decision.
router.get("/subscribers", protect, adminOnly, listSubscribers);
router.get("/downgraded", protect, adminOnly, listDowngraded);
router.get("/credited", protect, adminOnly, listCredited);
router.get("/upgrade-requests", protect, adminOnly, listUpgradeRequests);
router.patch("/upgrade-requests/:id", protect, adminOnly, decideUpgradeRequest);

module.exports = router;
