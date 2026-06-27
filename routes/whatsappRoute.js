const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const User = require("../models/userModel");
const {
  getStatus,
  getQrDataUrl,
  logout,
  initWhatsApp,
  sendMessage,
  sendToChat,
  listGroups,
  getNotifyGroupId,
  setNotifyGroupId,
  getInviteLink,
  setInviteLink,
  isInNotifyGroup,
} = require("../helper/whatsapp");

// PUBLIC: the group invite link, so a student (not a teacher) can be sent to the
// group after entering their phone. Not sensitive — anyone with it can join.
router.get("/invite", (req, res) => {
  res.json({ link: getInviteLink() });
});

// Verify the logged-in user is actually in the notify group (by their registered
// phone). On success, remember it on the account so the gate stops prompting.
router.get("/check-join", protect, async (req, res) => {
  const result = await isInNotifyGroup(req.user?.phone);
  if (result.joined && req.user && !req.user.whatsappGroupJoined) {
    try {
      await User.findByIdAndUpdate(req.user._id, { whatsappGroupJoined: true });
    } catch (e) {
      console.error("[WHATSAPP] mark joined failed:", e.message);
    }
  }
  res.json(result);
});

// Admin/teacher-only WhatsApp linking controls. The QR is how the owner links
// the sending phone number (WhatsApp → Linked devices → Link a device).
router.get("/status", protect, teacherOnly, (req, res) => {
  res.json(getStatus());
});

router.get("/qr", protect, teacherOnly, (req, res) => {
  // Make sure the client is booting (in case it crashed/disconnected).
  initWhatsApp();
  res.json({ ...getStatus(), qr: getQrDataUrl() });
});

router.post("/logout", protect, teacherOnly, async (req, res) => {
  await logout();
  res.json({ ok: true });
});

// Send a test message (to the given phone, or the caller's own phone) to confirm
// the linked number actually sends — independent of the exam targeting logic.
router.post("/test", protect, teacherOnly, async (req, res) => {
  const phone = req.body?.phone || req.user?.phone;
  if (!phone) return res.status(400).json({ ok: false, message: "Telefon nömrəsi yoxdur" });
  const ok = await sendMessage(
    phone,
    "✅ BunkerMath WhatsApp testi — bağlantı işləyir. Yeni imtahanlar bura gələcək."
  );
  res.json({ ok, phone });
});

// --- notification group: list the linked account's groups, get/set the chosen
// one (all exam alerts go to it as a single message), and send it a test. ---
router.get("/groups", protect, teacherOnly, async (req, res) => {
  res.json({
    groups: await listGroups(),
    selected: getNotifyGroupId(),
    inviteLink: getInviteLink(),
  });
});

router.post("/group", protect, teacherOnly, (req, res) => {
  if (req.body?.groupId !== undefined) setNotifyGroupId(req.body.groupId || "");
  if (req.body?.inviteLink !== undefined) setInviteLink(req.body.inviteLink || "");
  res.json({ ok: true, selected: getNotifyGroupId(), inviteLink: getInviteLink() });
});

router.post("/group/test", protect, teacherOnly, async (req, res) => {
  const groupId = getNotifyGroupId();
  if (!groupId) return res.status(400).json({ ok: false, message: "Qrup seçilməyib" });
  const ok = await sendToChat(
    groupId,
    "✅ BunkerMath bildiriş qrupu qoşuldu. Yeni imtahanlar bura göndəriləcək."
  );
  res.json({ ok });
});

module.exports = router;
