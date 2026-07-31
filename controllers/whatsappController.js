const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const User = require("../models/userModel");
const {
  getStatusFor,
  sendMessageFor,
  toDigits,
} = require("../helper/whatsapp");
const { httpError } = require("../utils/appError");

const MAX_ADMIN_MESSAGE_LENGTH = 3000;

// Admin-only, one-recipient support message. The browser sends a user id and
// reviewed message text; the recipient phone is always resolved from the
// persisted User row so a caller cannot substitute an arbitrary number.
const sendAdminUserMessage = asyncHandler(async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > MAX_ADMIN_MESSAGE_LENGTH) {
    throw httpError(
      400,
      "whatsapp_message_invalid",
      `Mesaj 1–${MAX_ADMIN_MESSAGE_LENGTH} simvol arasında olmalıdır.`
    );
  }

  if (!mongoose.isValidObjectId(req.params.userId)) {
    throw httpError(404, "whatsapp_recipient_not_found", "İstifadəçi tapılmadı.");
  }

  const recipient = await User.findOne({
    _id: req.params.userId,
    deletedAt: null,
  })
    .select("phone")
    .lean();

  if (!recipient) {
    throw httpError(404, "whatsapp_recipient_not_found", "İstifadəçi tapılmadı.");
  }
  if (!toDigits(recipient.phone)) {
    throw httpError(
      422,
      "whatsapp_phone_missing",
      "Bu istifadəçinin WhatsApp üçün etibarlı telefon nömrəsi yoxdur."
    );
  }

  const ownerId = String(req.user._id);
  const status = getStatusFor(ownerId);
  if (!status.enabled) {
    throw httpError(503, "whatsapp_disabled", "WhatsApp xidməti aktiv deyil.");
  }
  if (!status.ready) {
    throw httpError(
      409,
      "whatsapp_not_connected",
      "WhatsApp hesabınız qoşulmayıb. Əvvəlcə Bağlantılar səhifəsindən hesabınızı qoşun."
    );
  }

  const delivered = await sendMessageFor(ownerId, recipient.phone, message);
  if (!delivered) {
    throw httpError(
      502,
      "whatsapp_send_failed",
      "Mesaj göndərilmədi. Nömrəni və WhatsApp bağlantısını yoxlayıb yenidən cəhd edin."
    );
  }

  res.json({ ok: true });
});

module.exports = { sendAdminUserMessage, MAX_ADMIN_MESSAGE_LENGTH };
