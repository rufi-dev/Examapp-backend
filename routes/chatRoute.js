const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
  ping,
  nudge,
  welcome,
  listConversations,
  startConversation,
  contactAdmin,
  getMessages,
  sendMessage,
  setConversationAi,
} = require("../controllers/chatController");

// Presence heartbeat + unread badge (any logged-in user; the widget itself is
// only mounted for staff on the client).
router.post("/ping", protect, ping);

// Force-open a thread on the other participant's screen (picked up by their
// next heartbeat). Participant-only.
router.post("/conversations/:id/nudge", protect, nudge);

// Pause/resume the AI auto-reply for a thread — "human control" (admin only).
router.post("/conversations/:id/ai", protect, adminOnly, setConversationAi);

// My conversations, and starting a new one (admin-initiated support chat).
router.get("/conversations", protect, listConversations);
router.post("/conversations", protect, adminOnly, startConversation);

// Any staff member (teacher) opening a chat with the admin themselves.
router.post("/contact-admin", protect, contactAdmin);

// One-time personal welcome from the admin, fired when a teacher first lands
// in the app (idempotent server-side).
router.post("/welcome", protect, welcome);

// A single thread: read (marks incoming as read) and send. Participant-only,
// enforced in the controller — so a teacher can reply but only in their own
// conversations.
router.get("/conversations/:id/messages", protect, getMessages);
router.post("/conversations/:id/messages", protect, sendMessage);

module.exports = router;
