const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
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
} = require("../helper/whatsapp");

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
  res.json({ groups: await listGroups(), selected: getNotifyGroupId() });
});

router.post("/group", protect, teacherOnly, (req, res) => {
  setNotifyGroupId(req.body?.groupId || "");
  res.json({ ok: true, selected: getNotifyGroupId() });
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
