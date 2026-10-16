const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Conversation = require("../models/conversationModel");
const Message = require("../models/messageModel");
const Exam = require("../models/examModel");
const Presence = require("../models/presenceModel");
const User = require("../models/userModel");
const { httpError } = require("../utils/appError");
const { isChatAiEnabled, generateSupportReply } = require("../services/chatAssistant");
const typing = require("../helper/chatTyping");
const ui = require("../helper/uiCatalog");
const { VOICE_MAX_SEC, VOICE_PER_DAY, isVoiceUrl, voicePreview, hearVoice } = require("../helper/chatVoice");
const actions = require("../helper/teacherActions");

// The card a reply carries (helper/teacherActions), as the client sees it.
const actionView = (a) =>
  a && a.kind
    ? { kind: a.kind, title: a.title, lines: a.lines || [], status: a.status, result: a.result || "", link: a.link || "", prompt: a.kind === "create_exam" ? a.params?.prompt || "" : undefined, classId: a.kind === "create_exam" ? a.params?.classId || "" : undefined }
    : null;

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

  // The welcome is NOT sent from here any more: it waits for the dashboard (see
  // `welcome` below), so it never lands in the middle of the first-exam steps.

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

// The hello in the chat bubble. Teachers see the chat as "Examopia Köməkçi"
// (owner's call, 2026-10-13), so it introduces the assistant rather than signing
// with the admin's name: a person's name under an AI header reads as a mix-up.
//
// It arrives on the dashboard after the first-exam steps, so it speaks to where
// the teacher is: with an exam made, the step that makes it useful (inviting
// students), shown with the real-screen guide; without one, how to make it.
// The perks are the reasons teachers stay, said plainly.
const WELCOME_PERKS =
  "Examopia ilə bundan da çoxunu edə bilərsiniz:\n" +
  "• İstənilən fəndən AI ilə bir neçə dəqiqəyə yeni imtahan, cavablar avtomatik yoxlanılır\n" +
  "• Ev tapşırığı, dərs cədvəli və QR kodla davamiyyət — hamısı bir yerdə\n" +
  "• Valideynlərə WhatsApp bildirişləri: nəticə, davamiyyət, tapşırıq\n" +
  "• AI ilə dərs planı və çapa hazır iş vərəqləri";
const WELCOME_ASK = "Sualınız olsa, elə buradan yazın — bir neçə saniyəyə cavab verirəm, lazım olsa ekran şəkilləri ilə göstərirəm 🙂";
// The picture guide under it, from the screen catalogue (none if a capture lacks these).
const WELCOME_STEPS = {
  invite: ["class-page.sagird-devet-et", "class-invite.qosulma-linkini-kopyala"],
  exam: ["class-page.imtahan-elave-et", "composer.suallari-hazirla"],
};
const welcomeText = (teacher, hasExam) => {
  const hi = `Salam ${firstName(teacher)} 👋 Mən Examopia Köməkçisiyəm.`;
  return hasExam
    ? `${hi} İlk imtahanınız hazırdır — təbriklər! 🎉\n\n` +
        "İndi ən vacib addım: sinif səhifəsindəki «Şagird dəvət et» ilə linki şagirdlərə göndərin. " +
        "Onlar imtahanı yazan kimi cavablar avtomatik yoxlanılır, nəticələr sizə hazır gəlir.\n\n" +
        `${WELCOME_PERKS}\n\n${WELCOME_ASK}\n\n${ui.stepsMarker(WELCOME_STEPS.invite)}`
    : `${hi} Xoş gəldiniz! 🎉\n\n` +
        "İlk imtahanınızı bir neçə dəqiqəyə hazırlaya bilərsiniz: sinfi açın, «İmtahan əlavə et»ə basın " +
        "və mövzunu bir cümlə ilə yazın — qalanını AI edir.\n\n" +
        `${WELCOME_PERKS}\n\n${WELCOME_ASK}\n\n${ui.stepsMarker(WELCOME_STEPS.exam)}`;
};

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

  const hasExam = !!(await Exam.exists({ owner: teacherId, deletedAt: null }));
  const text = welcomeText(teacherName, hasExam);
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

// One-time welcome: the page calls this when a teacher reaches the dashboard
// after the first-exam steps. Atomically claims `chatWelcomedAt`, so it is sent
// exactly once, ever, and only to a working teacher.
const welcome = asyncHandler(async (req, res) => {
  const claimed = await User.findOneAndUpdate(
    { _id: req.user._id, role: "teacher", teacherApproval: { $in: ["approved", "approved_legacy"] }, chatWelcomedAt: null },
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
      audioUrl: m.audioUrl || "",
      audioSec: m.audioSec || 0,
      transcript: m.transcript || "",
      ai: !!m.ai,
      action: actionView(m.action),
      createdAt: m.createdAt,
      readAt: m.readAt,
    })),
    peerOnline: isFresh(presence.get(String(peerId))),
    readWatermark,
    aiPaused: !!conv.aiPaused,
    // True only while a reply is really being written (see helper/chatTyping).
    aiTyping: typing.isTyping(conv._id),
    // Whether the AI answers this thread at all: the teacher's header says
    // "Dərhal cavab verir" only when it is true.
    aiActive: isChatAiEnabled() && !conv.aiPaused,
  });
});

// Send a message (participant-only), and denormalise the last-message preview
// onto the conversation so the list can render without a per-row lookup.
const sendMessage = asyncHandler(async (req, res) => {
  const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
  const imageUrl = typeof req.body.imageUrl === "string" ? req.body.imageUrl.trim() : "";
  const audioUrl = typeof req.body.audioUrl === "string" ? req.body.audioUrl.trim() : "";
  const audioSec = Math.round(Math.max(0, Math.min(Number(req.body.audioSec) || 0, VOICE_MAX_SEC)) * 10) / 10;
  if (text.length > MAX_TEXT) throw httpError(400, "too_long", "Mesaj çox uzundur.");
  if (imageUrl && !isCloudinaryUrl(imageUrl)) throw httpError(400, "bad_image", "Şəkil qəbul edilmədi.");
  if (audioUrl && !isVoiceUrl(audioUrl)) throw httpError(400, "bad_audio", "Səs mesajı qəbul edilmədi.");
  if (Number(req.body.audioSec) > VOICE_MAX_SEC + 5) throw httpError(400, "too_long", "Səs mesajı ən çox 3 dəqiqə ola bilər.");
  if (!text && !imageUrl && !audioUrl) throw httpError(400, "empty", "Mesaj boşdur.");

  const conv = await Conversation.findById(req.params.id);
  if (!conv || !conv.participants.some((p) => String(p) === String(req.user._id)))
    throw httpError(404, "conversation_not_found", "Söhbət tapılmadı.");

  let transcript = "";
  let transcriptAlt = "";
  if (audioUrl) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const today = await Message.countDocuments({ from: req.user._id, audioUrl: { $ne: "" }, createdAt: { $gte: since } });
    if (today >= VOICE_PER_DAY) throw httpError(429, "voice_limit", "Bu gün çox səs mesajı göndərmisiniz. Zəhmət olmasa yazın.");
    const heard = await hearVoice(audioUrl);
    transcript = heard.text.slice(0, MAX_TEXT);
    transcriptAlt = heard.alt.slice(0, MAX_TEXT);
  }

  const to = conv.participants.find((p) => String(p) !== String(req.user._id));
  const msg = await Message.create({ conversation: conv._id, from: req.user._id, to, text, imageUrl, audioUrl, audioSec, transcript, transcriptAlt });

  conv.lastMessageText = text ? text.slice(0, 200) : audioUrl ? voicePreview(transcript) : "📷 Şəkil";
  conv.lastMessageAt = msg.createdAt;
  conv.lastMessageFrom = req.user._id;
  await conv.save();

  res.status(201).json({
    _id: msg._id,
    from: msg.from,
    to: msg.to,
    text: msg.text,
    imageUrl: msg.imageUrl || "",
    audioUrl: msg.audioUrl || "",
    audioSec: msg.audioSec || 0,
    transcript: msg.transcript || "",
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

  // "Yazır…" from here until the reply is saved, and not a moment longer: it is
  // cleared BEFORE the message is written, so no poll ever shows the dots under
  // an answer that already arrived. A turn that throws clears it in `finally`.
  const token = typing.startTyping(conversationId);
  let reply;
  let fresh;
  try {
    const teacherId = conv.participants.find((p) => String(p) !== String(adminId));
    const profile = await require("../helper/teacherContext").teacherContext(teacherId);
    // Their own classes and exams: what the chat can answer about and act on.
    const account = await actions.accountBrief(teacherId).catch((e) => {
      console.error("[CHAT-AI] account brief failed:", e?.message);
      return "";
    });
    reply = await generateSupportReply(recent, adminId, { profile, account });
    if (!reply) {
      console.warn("[CHAT-AI] no reply generated for", conversationId);
      return;
    }
    // Re-check the pause flag right before posting (admin may have taken over).
    fresh = await Conversation.findById(conversationId);
    if (!fresh || fresh.aiPaused) return;
  } finally {
    typing.stopTyping(conversationId, token);
  }

  const to = conv.participants.find((p) => String(p) !== String(adminId));
  /*
   * A reply may end with an action the AI prepared. It is checked against THIS
   * teacher's own data and becomes the card under the reply; nothing changes
   * until they confirm it. One that does not check out says why instead.
   */
  const { text: said, raw } = actions.splitAction(reply);
  let action;
  let text = said;
  // Still promising a card that is not there (after the one retry): say so.
  if (!raw && actions.promisesCard(said)) {
    console.warn("[CHAT-AI] reply still promises a card without one", conversationId);
    text = `${said}\n\nBağışlayın, kart hazırlanmadı. Nəyi dəyişmək istədiyinizi bir daha yazın, yenidən hazırlayım.`;
  }
  if (raw) {
    const teacher = await User.findById(to).select("role").lean();
    const ready = teacher ? await actions.prepare(raw, { _id: to, role: teacher.role }).catch((e) => ({ ok: false, why: e?.message || "xəta" })) : { ok: false, why: "müəllim tapılmadı" };
    if (ready.ok) action = { ...ready.action, status: "pending" };
    else {
      console.warn(`[CHAT-AI] action not prepared (${ready.why})`, conversationId);
      text = `${said}\n\nBağışlayın, bunu hazırlaya bilmədim: ${ready.why}. Bunu özünüz «Redaktə et» ilə edə bilərsiniz və ya mənə bir az dəqiq yazın.`;
    }
  }
  const aiMsg = await Message.create({
    conversation: conv._id,
    from: adminId,
    to,
    text,
    ai: true,
    ...(action ? { action } : {}),
  });
  fresh.lastMessageText = text.slice(0, 200);
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

/*
 * The teacher's answer to a card the AI prepared: «Təsdiq et» runs it, as the
 * teacher, with every check made again; «Ləğv et» drops it. Only the teacher
 * the card was written to may decide, and only once (pending → running is one
 * atomic step, so a double tap cannot run it twice).
 */
const decideAction = asyncHandler(async (req, res) => {
  const decision = req.body?.decision;
  if (!["confirm", "cancel"].includes(decision)) throw httpError(400, "bad_decision", "Təsdiq və ya ləğv seçin.");
  if (!mongoose.isValidObjectId(req.params.id)) throw httpError(404, "message_not_found", "Mesaj tapılmadı.");
  const msg = await Message.findById(req.params.id).lean();
  if (!msg || !msg.ai || !msg.action || String(msg.to) !== String(req.user._id))
    throw httpError(404, "message_not_found", "Mesaj tapılmadı.");
  if (msg.action.status !== "pending") return res.json({ action: actionView(msg.action) });

  if (decision === "cancel") {
    const done = await Message.findOneAndUpdate(
      { _id: msg._id, "action.status": "pending" },
      { $set: { "action.status": "cancelled", "action.result": "Ləğv edildi.", "action.decidedAt": new Date() } },
      { new: true }
    ).lean();
    return res.json({ action: actionView((done || msg).action) });
  }

  const claimed = await Message.findOneAndUpdate(
    { _id: msg._id, "action.status": "pending" },
    { $set: { "action.status": "running", "action.decidedAt": new Date() } },
    { new: true }
  ).lean();
  if (!claimed) {
    const now = await Message.findById(msg._id).lean();
    return res.json({ action: actionView(now?.action) });
  }
  let out;
  try {
    out = await actions.run(claimed.action, req.user);
  } catch (e) {
    console.error("[CHAT-ACTION] run failed:", e?.message);
    out = { ok: false, message: "Alınmadı: gözlənilməz xəta. Bir azdan yenidən cəhd edin." };
  }
  const saved = await Message.findOneAndUpdate(
    { _id: msg._id },
    { $set: { "action.status": out.ok ? "done" : "failed", "action.result": out.message || "", "action.link": out.link || "" } },
    { new: true }
  ).lean();
  res.json({ action: actionView(saved.action) });
});

module.exports = { ping, nudge, welcome, listConversations, startConversation, contactAdmin, getMessages, sendMessage, setConversationAi, decideAction };
