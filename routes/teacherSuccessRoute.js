const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { requireJourney, teacherOrAdmin } = require("../middleware/journeyFlag");
const c = require("../controllers/teacherSuccessController");

// CR-128#4: requireJourney runs BEFORE protect, so a flag-off deployment returns
// 404 for the whole surface even for an anonymous or invalid-token request (no
// auth work, no existence signal). Growth level is never an authz signal.

// ── Teacher (any level, including a new pending Spark teacher) ──
// /me is TEACHER-ONLY (CR-128#5: an admin never participates in /me or gets an AI period).
router.get("/me", requireJourney, protect, c.getMyJourney);
router.get("/activity", requireJourney, protect, c.getMyActivity);
router.post("/welcome-seen", requireJourney, protect, c.markWelcomeSeen);
router.get("/xp-rules", requireJourney, protect, teacherOrAdmin, c.getXpRules);
router.get("/referral", requireJourney, protect, teacherOrAdmin, c.getMyReferral);
router.post("/upgrade-request", requireJourney, protect, teacherOrAdmin, c.submitUpgradeRequest);
router.get("/upgrade-requests", requireJourney, protect, teacherOrAdmin, c.getMyUpgradeRequests);

// ── Admin ──
router.get("/admin/teachers", requireJourney, protect, adminOnly, c.adminListTeachers);
router.get("/admin/teacher/:id", requireJourney, protect, adminOnly, c.adminGetTeacher);
router.post("/admin/promote", requireJourney, protect, adminOnly, c.adminPromote);
router.post("/admin/correct", requireJourney, protect, adminOnly, c.adminCorrect);
router.post("/admin/grant", requireJourney, protect, adminOnly, c.adminGrant);
router.post("/admin/xp-correct", requireJourney, protect, adminOnly, c.adminXpCorrect);
router.get("/admin/referrals", requireJourney, protect, adminOnly, c.adminListReferrals);
router.post("/admin/referral/:id/review", requireJourney, protect, adminOnly, c.adminReviewReferral);
router.get("/admin/upgrade-requests", requireJourney, protect, adminOnly, c.adminListUpgradeRequests);
router.post("/admin/upgrade-request/:id/decide", requireJourney, protect, adminOnly, c.adminDecideUpgrade);

module.exports = router;
