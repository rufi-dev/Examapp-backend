const express = require("express");
const router = express.Router();
const { protect, teacherOnly } = require("../middleware/authMiddleware");
const { getStatus, getQrDataUrl, logout, initWhatsApp, sendMessage } = require("../helper/whatsapp");

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

module.exports = router;
