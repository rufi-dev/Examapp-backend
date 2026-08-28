const express = require("express");
const router = express.Router();
const { protect, adminOnly, teacherOnly } = require("../middleware/authMiddleware");
const { effectivePlan } = require("../helper/planLimits");
const { featuresFor } = require("../config/plans");
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
  capacity,
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

// ── TEACHER surface: link YOUR OWN number, so parent notifications go out from it ──
//
// Premium only. Every linked number is a headless Chromium on the server, so this
// is capacity-bound (see `capacity`), not just a pricing choice. A teacher gets
// exactly ONE slot and it is always derived from their own session — the slot is
// never taken from the request, so nobody can drive another teacher's session.
const teacherKey = (req) => accountKey(req.user._id, 1);

const premiumWhatsApp = (req, res, next) => {
  if (req.user?.role === "admin") return next();
  if (featuresFor(effectivePlan(req.user)).teacherWhatsApp) return next();
  return res.status(403).json({
    ok: false,
    code: "PLAN_REQUIRED",
    message: "Öz WhatsApp nömrənizi qoşmaq Premium paketə daxildir.",
  });
};
const teacherGate = [protect, teacherOnly, premiumWhatsApp];

router.get("/teacher/status", ...teacherGate, (req, res) => {
  res.json({ ...getStatusFor(teacherKey(req)), capacity: capacity(teacherKey(req)) });
});

router.get("/teacher/qr", ...teacherGate, (req, res) => {
  const cap = capacity(teacherKey(req));
  // Refuse clearly instead of returning a QR that can never appear.
  if (!cap.free) {
    return res.status(503).json({
      ok: false,
      code: "NO_SLOT",
      message: "Hazırda boş WhatsApp yeri yoxdur. Bir az sonra yenidən cəhd edin.",
      capacity: cap,
    });
  }
  initFor(teacherKey(req));
  res.json({ ...getStatusFor(teacherKey(req)), qr: getQrFor(teacherKey(req)), capacity: cap });
});

router.post("/teacher/qr/refresh", ...teacherGate, (req, res) => {
  refreshFor(teacherKey(req));
  res.json({ ok: true });
});

router.post("/teacher/logout", ...teacherGate, async (req, res) => {
  await logoutFor(teacherKey(req));
  res.json({ ok: true });
});

router.post("/teacher/test", ...teacherGate, async (req, res) => {
  const phone = req.body?.phone || req.user?.phone;
  if (!phone) return res.status(400).json({ ok: false, message: "Telefon nömrəsi yoxdur" });
  const ok = await sendMessageFor(
    teacherKey(req),
    phone,
    "✅ Examopia WhatsApp testi — bağlantı işləyir. Valideyn bildirişləri bu nömrədən gedəcək."
  );
  res.json({ ok, phone });
});

module.exports = router;
