const express = require("express");
const router = express.Router();
const { protect, adminOnly } = require("../middleware/authMiddleware");
const { sendAdminUserMessage } = require("../controllers/whatsappController");
const User = require("../models/userModel");
const {
  getStatusFor,
  getQrFor,
  logoutFor,
  initFor,
  refreshFor,
  sendMessageFor,
  sendForOwner,
  listGroupsFor,
  accountKey,
} = require("../helper/whatsapp");

// ADMIN-ONLY: WhatsApp linking is an admin surface (the /connections page is
// hidden from teachers and gated to admins). Every endpoint is scoped to the
// logged-in admin's own session — they link a number and pick the notify group;
// nobody else's session is touched.
const oid = (req) => String(req.user._id);
// The admin may link a SECOND number in slot 2 (?slot=2 or body.slot). Slot 1 is
// the original session (bare id), so an already-linked number keeps working. Only
// the per-number linking surface (status/qr/logout/test) is slot-aware; the notify
// group lives on the user doc (one group) and stays on slot 1.
const key = (req) => accountKey(req.user._id, req.query.slot ?? req.body?.slot);

// Direct support outreach from the logged-in ADMIN's connected WhatsApp.
// The controller resolves the selected user's phone server-side; the client
// cannot turn this into an arbitrary-number sending endpoint.
router.post(
  "/admin/users/:userId/message",
  protect,
  adminOnly,
  sendAdminUserMessage
);

router.get("/status", protect, adminOnly, (req, res) => {
  res.json(getStatusFor(key(req)));
});

router.get("/qr", protect, adminOnly, (req, res) => {
  initFor(key(req)); // lazily boot this slot's session if not running
  res.json({ ...getStatusFor(key(req)), qr: getQrFor(key(req)) });
});

// Force a clean restart when the QR is stuck (a hung Chromium / expired session):
// resets the retry budget and recycles the client, so a new QR is generated.
router.post("/qr/refresh", protect, adminOnly, (req, res) => {
  refreshFor(key(req));
  res.json({ ok: true });
});

router.post("/logout", protect, adminOnly, async (req, res) => {
  await logoutFor(key(req));
  res.json({ ok: true });
});

// Send a test message (to the given phone, or the caller's own) from this
// teacher's linked number.
router.post("/test", protect, adminOnly, async (req, res) => {
  const phone = req.body?.phone || req.user?.phone;
  if (!phone) return res.status(400).json({ ok: false, message: "Telefon nömrəsi yoxdur" });
  const ok = await sendMessageFor(
    key(req),
    phone,
    "✅ Examopia WhatsApp testi — bağlantı işləyir. Yeni imtahanlar bura gələcək."
  );
  res.json({ ok, phone });
});

// Notification group for THIS teacher: list their groups, get/set the chosen one
// (+ optional invite link), and send it a test. The choice lives on the user.
router.get("/groups", protect, adminOnly, async (req, res) => {
  const me = await User.findById(req.user._id).select("whatsappGroupId whatsappInviteLink").lean();
  res.json({
    groups: await listGroupsFor(oid(req)),
    selected: me?.whatsappGroupId || "",
    inviteLink: me?.whatsappInviteLink || "",
  });
});

router.post("/group", protect, adminOnly, async (req, res) => {
  const update = {};
  if (req.body?.groupId !== undefined) update.whatsappGroupId = req.body.groupId || "";
  if (req.body?.inviteLink !== undefined) {
    update.whatsappInviteLink =
      typeof req.body.inviteLink === "string" ? req.body.inviteLink.trim() : "";
  }
  const me = await User.findByIdAndUpdate(req.user._id, update, { new: true }).select(
    "whatsappGroupId whatsappInviteLink"
  );
  res.json({ ok: true, selected: me?.whatsappGroupId || "", inviteLink: me?.whatsappInviteLink || "" });
});

router.post("/group/test", protect, adminOnly, async (req, res) => {
  const me = await User.findById(req.user._id).select("whatsappGroupId").lean();
  const groupId = me?.whatsappGroupId || "";
  if (!groupId) return res.status(400).json({ ok: false, message: "Qrup seçilməyib" });
  const ok = await sendForOwner(
    oid(req),
    groupId,
    "✅ Examopia bildiriş qrupu qoşuldu. Yeni imtahanlar bura göndəriləcək."
  );
  res.json({ ok });
});

module.exports = router;
