const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Conversation = require("../models/conversationModel");
const Message = require("../models/messageModel");
const Presence = require("../models/presenceModel");
const User = require("../models/userModel");
const { httpError } = require("../utils/appError");
const { isChatAiEnabled, generateSupportReply } = require("../services/chatAssistant");

// A user counts as "online" if their last heartbeat is within this window. The
// client pings every ~30s, so 75s tolerates one dropped ping without flicker.
const ONLINE_WINDOW_MS = 75 * 1000;
const MAX_TEXT = 4000;
// A nudge is a "right now" action; if the target isn't around to pick it up
// within a couple of minutes it is stale and ignored.
const NUDGE_TTL_MS = 2 * 60 * 1000;

const isFresh = (d) => !!d && Date.now() - new Date(d).getTime() < ONLINE_WINDOW_MS;

// Only accept image URLs on our own Cloudinary host (matches the frontend upload
// and the img-src CSP) — the client cannot inject an arbitrary remote URL.
function isCloudinaryUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "res.cloudinary.com";
  } catch {
    return false;
  }
}

// Online state for a set of user ids in one query.
async function presenceMapFor(ids) {
  const clean = ids.filter(Boolean);
  if (!clean.length) return new Map();
  const rows = await Presence.find({ user: { $in: clean } }).select("user lastSeenAt").lean();
  return new Map(rows.map((r) => [String(r.user), r.lastSeenAt]));
}

const otherParticipant = (conv, meId) =>
  conv.participants.find((p) => String(p._id || p) !== String(meId));

// Heartbeat: mark me present and return my total unread so a single call keeps
// both the presence signal and the badge fresh.
const ping = asyncHandler(async (req, res) => {
  await Presence.updateOne(
    { user: req.user._id },
    { $set: { lastSeenAt: new Date() } },
    { upsert: true }
  );
  const unread = await Message.countDocuments({ to: req.user._id, readAt: null });

  // Reliable welcome: a capable teacher whose account has aged past the delay and
  // who was never welcomed gets it here — surviving short sessions / reloads that
  // the client-side timer misses. No-op for everyone else. Best-effort.
  maybeSendWelcome(req.user._id).catch(() => {});

  // Did someone ask us to pop a specific thread open? Return it once, then clear.
  let openConversationId = null;
  const nudged = await Conversation.findOne({
    nudgeFor: req.user._id,
    nudgeAt: { $gt: new Date(Date.now() - NUDGE_TTL_MS) },
  })
    .sort({ nudgeAt: -1 })
    .select("_id");
  if (nudged) {
    openConversationId = nudged._id;
    await Conversation.updateOne({ _id: nudged._id }, { $set: { nudgeFor: null } });
  }

  res.json({ ok: true, unread, openConversationId });
});

// "Open this conversation on the other person's screen now." Sets a one-shot
// flag the target's next heartbeat consumes. Participant-only.
const nudge = asyncHandler(async (req, res) => {
  const conv = await Conversation.findById(req.params.id);
  if (!conv || !conv.participants.some((p) => String(p) === String(req.user._id)))
    throw httpError(404, "conversation_not_found", "Söhbət tapılmadı.");
  const target = conv.participants.find((p) => String(p) !== String(req.user._id));
  conv.nudgeFor = target;
  conv.nudgeAt = new Date();
  await conv.save();
  res.json({ ok: true });
});

// My conversations, newest activity first, each with the peer, their online
// state and my unread count in that thread.
const listConversations = asyncHandler(async (req, res) => {
  const me = req.user._id;
  const convs = await Conversation.find({ participants: me })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .populate("participants", "name role photo phone")
    .lean();
  const isAdmin = req.user.role === "admin";

  const peerIds = convs.map((c) => otherParticipant(c, me)).filter(Boolean).map((p) => p._id);
  const presence = await presenceMapFor(peerIds);

  const unreadRows = await Message.aggregate([
    { $match: { to: new mongoose.Types.ObjectId(String(me)), readAt: null } },
    { $group: { _id: "$conversation", n: { $sum: 1 } } },
  ]);
  const unreadMap = new Map(unreadRows.map((r) => [String(r._id), r.n]));

  res.json(
    convs.map((c) => {
      const peer = otherParticipant(c, me) || {};
      return {
        _id: c._id,
        peer: {
          _id: peer._id,
          name: peer.name || "İstifadəçi",
          role: peer.role,
          photo: peer.photo || "",
          online: isFresh(presence.get(String(peer._id))),
          // Only admins get the other side's phone (to WhatsApp the teacher);
          // teachers never receive the admin's number this way.
          ...(isAdmin ? { phone: peer.phone || "" } : {}),
        },
        lastMessageText: c.lastMessageText || "",
        lastMessageAt: c.lastMessageAt,
        lastMessageFrom: c.lastMessageFrom,
        unread: unreadMap.get(String(c._id)) || 0,
        aiPaused: !!c.aiPaused,
      };
    })
  );
});

// Start (or re-open) a conversation with a user. Only admins may OPEN one; the
// pair key means a repeat "connect" returns the SAME conversation, never a dup.
const startConversation = asyncHandler(async (req, res) => {
  const otherId = req.body.userId;
  if (!mongoose.isValidObjectId(otherId)) throw httpError(400, "bad_user", "İstifadəçi seçilməyib.");
  if (String(otherId) === String(req.user._id)) throw httpError(400, "self_chat", "Özünüzlə söhbət olmaz.");

  const other = await User.findById(otherId).select("name role photo phone").lean();
  if (!other) throw httpError(404, "user_not_found", "İstifadəçi tapılmadı.");

  const key = Conversation.keyFor(req.user._id, otherId);
  let conv = await Conversation.findOne({ key });
  if (!conv) {
    conv = await Conversation.create({
      participants: [req.user._id, otherId],
      key,
      createdBy: req.user._id,
    });
  }

  const presence = await presenceMapFor([otherId]);
  res.status(201).json({
    _id: conv._id,
    peer: {
      _id: other._id,
      name: other.name,
      role: other.role,
      photo: other.photo || "",
      online: isFresh(presence.get(String(otherId))),
      phone: other.phone || "", // requester is always an admin here
    },
    lastMessageText: conv.lastMessageText || "",
    lastMessageAt: conv.lastMessageAt,
    lastMessageFrom: conv.lastMessageFrom,
    unread: 0,
    aiPaused: !!conv.aiPaused,
  });
});

// Teacher-facing entry: open (or re-open) a conversation with the admin so any
// staff member can reach support without the admin starting it first. Picks the
// primary (oldest) admin when there is more than one.
const contactAdmin = asyncHandler(async (req, res) => {
  const admin = await User.findOne({ role: "admin" })
    .sort({ createdAt: 1 })
    .select("name role photo")
    .lean();
  if (!admin) throw httpError(404, "no_admin", "Admin tapılmadı.");
  if (String(admin._id) === String(req.user._id))
    throw httpError(400, "self_chat", "Siz adminsiniz.");

  const key = Conversation.keyFor(req.user._id, admin._id);
  let conv = await Conversation.findOne({ key });
  if (!conv) {
    conv = await Conversation.create({
      participants: [req.user._id, admin._id],
      key,
      createdBy: req.user._id,
    });
  }

  const presence = await presenceMapFor([admin._id]);
  res.status(201).json({
    _id: conv._id,
    peer: {
      _id: admin._id,
      name: admin.name,
      role: admin.role,
      photo: admin.photo || "",
      online: isFresh(presence.get(String(admin._id))),
    },
    lastMessageText: conv.lastMessageText || "",
    lastMessageAt: conv.lastMessageAt,
    lastMessageFrom: conv.lastMessageFrom,
    unread: 0,
  });
});

const firstName = (s) => String(s || "").trim().split(/\s+/)[0] || "";

// The admin's personal hello. Written to read like a real person typed it, not a
// broadcast — greets by name and signs off with the admin's own first name.
const welcomeText = (teacher, admin) =>
  `Salam ${firstName(teacher)} 👋 Mən ${firstName(admin)}, Examopia-nı quran komandadanam. ` +
  `Aramıza qoşulduğun üçün ürəkdən təşəkkür edirəm! İmtahan hazırlayarkən nəsə qarışıq gəlsə, ` +
  `ya da istənilən sualın-problemin olsa, çəkinmədən birbaşa buradan mənə yaz — həmişə kömək ` +
  `etməyə hazıram. Uğurlar! 🙌`;

// Post the admin's welcome into a (created-if-needed) chat with the teacher.
// The caller is responsible for having ATOMICALLY claimed `chatWelcomedAt` first
// (so this only ever runs once per teacher). Returns true if a message was sent.
async function deliverWelcome(teacherId, teacherName) {
  const admin = await User.findOne({ role: "admin" })
    .sort({ createdAt: 1 })
    .select("name")
    .lean();
  if (!admin) return false;

  const key = Conversation.keyFor(admin._id, teacherId);
  let conv = await Conversation.findOne({ key });
  if (!conv) {
    conv = await Conversation.create({
      participants: [admin._id, teacherId],
      key,
      createdBy: admin._id,
    });
  }

  const text = welcomeText(teacherName, admin.name);
  const msg = await Message.create({
    conversation: conv._id,
    from: admin._id,
    to: teacherId,
    text,
  });
  conv.lastMessageText = text.slice(0, 200);
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessageFrom = admin._id;
  await conv.save();
  return true;
}

// The welcome is DELAYED (feels human, not an instant autoresponder) but must be
// RELIABLE — it can't depend on a teacher keeping one page open for a full minute.
// Both the explicit /welcome call and the heartbeat below only fire it once the
// account is at least this old, and both claim `chatWelcomedAt` atomically. A
// teacher who left before it fired simply gets it on their next visit's heartbeat.
const WELCOME_DELAY_MS = 60 * 1000;

// Atomically claim + send the welcome to a CAPABLE teacher whose account has
// aged past the delay. No-op (returns false) for anyone already welcomed, not a
// capable teacher, or too new. Safe to call on every heartbeat.
async function maybeSendWelcome(userId) {
  const claimed = await User.findOneAndUpdate(
    {
      _id: userId,
      role: "teacher",
      teacherApproval: { $in: ["approved", "approved_legacy"] },
      chatWelcomedAt: null,
      createdAt: { $lte: new Date(Date.now() - WELCOME_DELAY_MS) },
    },
    { $set: { chatWelcomedAt: new Date() } },
    { new: false }
  ).select("name");
  if (!claimed) return false;
  return deliverWelcome(claimed._id, claimed.name);
}

// One-time welcome: when a teacher first lands in the app, drop a personal
// message from the admin into a chat with them, so they know they can reach out.
// Atomically claims `chatWelcomedAt` so concurrent calls send it exactly once.
const welcome = asyncHandler(async (req, res) => {
  const claimed = await User.findOneAndUpdate(
    { _id: req.user._id, role: { $ne: "admin" }, chatWelcomedAt: null },
    { $set: { chatWelcomedAt: new Date() } },
    { new: false }
  ).select("name");
  if (!claimed) return res.json({ ok: true, sent: false });

  const sent = await deliverWelcome(claimed._id, claimed.name);
  res.json({ ok: true, sent });
});

// Load a thread (participant-only) and mark my incoming messages read. `after`
// lets the client poll for only-new messages so payloads stay tiny.
const getMessages = asyncHandler(async (req, res) => {
  const conv = await Conversation.findById(req.params.id).lean();
  if (!conv || !conv.participants.some((p) => String(p) === String(req.user._id)))
    throw httpError(404, "conversation_not_found", "Söhbət tapılmadı.");

  const after = req.query.after ? new Date(req.query.after) : null;
  const filter = { conversation: conv._id };
  if (after && !Number.isNaN(after.getTime())) filter.createdAt = { $gt: after };

  const messages = await Message.find(filter).sort({ createdAt: 1 }).limit(500).lean();

  await Message.updateMany(
    { conversation: conv._id, to: req.user._id, readAt: null },
    { $set: { readAt: new Date() } }
  );

  // Read watermark for MY sent messages: the latest time the peer read one of
  // them. The incremental (`after`) fetch never re-sends my old messages, so
  // this is how my client learns they were read — every message I sent at or
  // before this instant is "read". Computed globally for the thread, so it stays
  // correct no matter which slice of messages this response carries.
  const readAgg = await Message.aggregate([
    {
      $match: {
        conversation: conv._id,
        from: new mongoose.Types.ObjectId(String(req.user._id)),
        readAt: { $ne: null },
      },
    },
    { $group: { _id: null, maxRead: { $max: "$readAt" } } },
  ]);
  const readWatermark = readAgg[0]?.maxRead || null;

  const peerId = conv.participants.find((p) => String(p) !== String(req.user._id));
  const presence = await presenceMapFor([peerId]);
  res.json({
    messages: messages.map((m) => ({
      _id: m._id,
      from: m.from,
      to: m.to,
      text: m.text,
      imageUrl: m.imageUrl || "",
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
    peerOnline: isFresh(presence.get(String(peerId))),
    readWatermark,
    aiPaused: !!conv.aiPaused,
  });
});

// Send a message (participant-only), and denormalise the last-message preview
// onto the conversation so the list can render without a per-row lookup.
const sendMessage = asyncHandler(async (req, res) => {
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const imageUrl = typeof req.body.imageUrl === "string" ? req.body.imageUrl.trim() : "";
  if (text.length > MAX_TEXT) throw httpError(400, "too_long", "Mesaj çox uzundur.");
  if (imageUrl && !isCloudinaryUrl(imageUrl)) throw httpError(400, "bad_image", "Şəkil qəbul edilmədi.");
  if (!text && !imageUrl) throw httpError(400, "empty", "Mesaj boşdur.");

  const conv = await Conversation.findById(req.params.id);
  if (!conv || !conv.participants.some((p) => String(p) === String(req.user._id)))
    throw httpError(404, "conversation_not_found", "Söhbət tapılmadı.");

  const to = conv.participants.find((p) => String(p) !== String(req.user._id));
  const msg = await Message.create({ conversation: conv._id, from: req.user._id, to, text, imageUrl });

  conv.lastMessageText = text ? text.slice(0, 200) : "📷 Şəkil";
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessageFrom = req.user._id;
  await conv.save();

  res.status(201).json({
    _id: msg._id,
    from: msg.from,
    to: msg.to,
    text: msg.text,
    imageUrl: msg.imageUrl || "",
    createdAt: msg.createdAt,
    readAt: msg.readAt,
  });

  // After replying to the sender, maybe let the AI answer for the admin. Only
  // when a NON-admin (teacher) wrote, the recipient is the admin, AI is globally
  // enabled and this thread isn't under human control. Fire-and-forget.
  if (req.user.role !== "admin" && !conv.aiPaused && isChatAiEnabled()) {
    maybeAiReply(String(conv._id), String(to)).catch((e) =>
      console.error("[CHAT-AI] maybeAiReply error:", e && e.message)
    );
  }
});

// Generate + post the AI's reply as the admin, if still appropriate. Guarded so
// it never loops (AI writes as the admin; it only fires on a teacher's message)
// and never double-answers if a human/AI reply already landed.
async function maybeAiReply(conversationId, adminId) {
  const conv = await Conversation.findById(conversationId);
  if (!conv || conv.aiPaused) return;
  const admin = await User.findById(adminId).select("role").lean();
  if (!admin || admin.role !== "admin") {
    console.warn("[CHAT-AI] skip: recipient is not an admin", conversationId);
    return; // only speak FOR an admin
  }

  const recent = await Message.find({ conversation: conv._id })
    .sort({ createdAt: -1 })
    .limit(20)
    .lean();
  recent.reverse();
  if (!recent.length) return;
  // If the last message is no longer the teacher's, someone already replied.
  if (String(recent[recent.length - 1].from) === String(adminId)) return;

  const reply = await generateSupportReply(recent, adminId);
  if (!reply) {
    console.warn("[CHAT-AI] no reply generated for", conversationId);
    return;
  }

  // Re-check the pause flag right before posting (admin may have taken over).
  const fresh = await Conversation.findById(conversationId);
  if (!fresh || fresh.aiPaused) return;

  const to = conv.participants.find((p) => String(p) !== String(adminId));
  const aiMsg = await Message.create({
    conversation: conv._id,
    from: adminId,
    to,
    text: reply,
  });
  fresh.lastMessageText = reply.slice(0, 200);
  fresh.lastMessageAt = aiMsg.createdAt;
  fresh.lastMessageFrom = adminId;
  await fresh.save();
}

// Toggle "human control" for a thread (admin only): pause/resume the AI reply.
const setConversationAi = asyncHandler(async (req, res) => {
  const conv = await Conversation.findById(req.params.id);
  if (!conv || !conv.participants.some((p) => String(p) === String(req.user._id)))
    throw httpError(404, "conversation_not_found", "Söhbət tapılmadı.");
  conv.aiPaused = !!req.body.paused;
  await conv.save();
  res.json({ ok: true, aiPaused: conv.aiPaused });
});

module.exports = { ping, nudge, welcome, listConversations, startConversation, contactAdmin, getMessages, sendMessage, setConversationAi };
