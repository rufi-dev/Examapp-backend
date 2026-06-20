const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const User = require("../models/userModel");
const {
  isTelegramConfigured,
  telegramDeepLink,
  sendTelegram,
  BOT_USERNAME,
} = require("../helper/telegram");

// A fresh URL-safe code for the deep link (Telegram start params allow
// [A-Za-z0-9_-], up to 64 chars).
const newLinkCode = () => crypto.randomBytes(24).toString("base64url");

// GET /api/telegram/status — is the bot configured, and is THIS user linked?
// When not linked, returns the deep link the teacher opens to connect.
const getTelegramStatus = asyncHandler(async (req, res) => {
  const configured = isTelegramConfigured();
  if (!configured) {
    return res.json({ configured: false, linked: false, botUsername: BOT_USERNAME });
  }
  const user = await User.findById(req.user._id).select(
    "telegramChatId telegramLinkCode telegramLinkedAt"
  );
  if (user.telegramChatId) {
    return res.json({
      configured: true,
      linked: true,
      botUsername: BOT_USERNAME,
      linkedAt: user.telegramLinkedAt,
    });
  }
  // Not linked: make sure a code exists, then hand back the deep link.
  let code = user.telegramLinkCode;
  if (!code) {
    code = newLinkCode();
    user.telegramLinkCode = code;
    await user.save();
  }
  res.json({
    configured: true,
    linked: false,
    botUsername: BOT_USERNAME,
    deepLink: telegramDeepLink(code),
  });
});

// POST /api/telegram/webhook — called by Telegram (public). Handles the
// `/start <code>` deep-link tap (binds the chat to the account) and `/stop`.
// Verified by a shared secret header so only Telegram can drive it. Always
// answers 200 fast so Telegram doesn't retry.
const telegramWebhook = asyncHandler(async (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    return res.status(403).json({ ok: false });
  }

  const msg = req.body?.message || req.body?.edited_message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text || "").trim();

  // Respond immediately; do the work without making Telegram wait.
  res.status(200).json({ ok: true });
  if (!chatId || !text) return;

  try {
    if (text.startsWith("/start")) {
      const code = text.split(/\s+/)[1];
      if (code) {
        const user = await User.findOne({ telegramLinkCode: code });
        if (user) {
          user.telegramChatId = String(chatId);
          user.telegramLinkCode = undefined; // one-time use
          user.telegramLinkedAt = new Date();
          await user.save();
          await sendTelegram(
            chatId,
            `✅ <b>${user.name}</b>, bildirişlər aktivdir!\n` +
              `Şagird imtahanlarınızdan birinə başladıqda buraya xəbər gələcək.`
          );
          return;
        }
      }
      await sendTelegram(
        chatId,
        "👋 Salam! Bildirişləri aktivləşdirmək üçün tətbiqdəki profil səhifənizdən " +
          "“Telegram-ı qoş” düyməsini istifadə edin."
      );
    } else if (text === "/stop") {
      await User.updateOne(
        { telegramChatId: String(chatId) },
        { $unset: { telegramChatId: "", telegramLinkedAt: "" } }
      );
      await sendTelegram(chatId, "🔕 Bildirişlər dayandırıldı.");
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[TELEGRAM] webhook handling failed:", e.message);
  }
});

// POST /api/telegram/test — send the logged-in user a test notification.
const testTelegram = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select("telegramChatId name");
  if (!user?.telegramChatId) {
    res.status(400);
    throw new Error("Telegram hələ qoşulmayıb");
  }
  const r = await sendTelegram(
    user.telegramChatId,
    `🔔 Test bildirişi — salam, <b>${user.name}</b>! Bildirişlər işləyir. ✅`
  );
  if (!r?.ok) {
    res.status(502);
    throw new Error("Test mesajı göndərilmədi");
  }
  res.json({ sent: true });
});

// POST /api/telegram/unlink — disconnect this user's Telegram.
const unlinkTelegram = asyncHandler(async (req, res) => {
  await User.updateOne(
    { _id: req.user._id },
    { $unset: { telegramChatId: "", telegramLinkCode: "", telegramLinkedAt: "" } }
  );
  res.json({ linked: false });
});

module.exports = {
  getTelegramStatus,
  telegramWebhook,
  testTelegram,
  unlinkTelegram,
};
