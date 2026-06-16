const asyncHandler = require("express-async-handler");
const Notification = require("../models/notificationModel");
const User = require("../models/userModel");

// Teacher/admin broadcasts a message to everyone.
const createNotification = asyncHandler(async (req, res) => {
  const { title, message } = req.body;
  if (!message || !message.trim()) {
    res.status(400);
    throw new Error("Mesaj boş ola bilməz");
  }
  const n = await Notification.create({
    title: (title || "").trim(),
    message: message.trim(),
    createdBy: req.user._id,
  });
  res.status(201).json(n);
});

// Recent notifications for the logged-in user + how many are unread.
const getNotifications = asyncHandler(async (req, res) => {
  const items = await Notification.find()
    .sort({ createdAt: -1 })
    .limit(30)
    .populate("createdBy", "name");
  const user = await User.findById(req.user._id).select("notificationsSeenAt");
  const seenAt = user?.notificationsSeenAt
    ? new Date(user.notificationsSeenAt).getTime()
    : 0;
  const unread = items.filter((n) => new Date(n.createdAt).getTime() > seenAt).length;
  res.status(200).json({ items, unread });
});

// Mark everything as seen for this user (clears the bell badge).
const markSeen = asyncHandler(async (req, res) => {
  await User.findByIdAndUpdate(req.user._id, { notificationsSeenAt: new Date() });
  res.status(200).json({ ok: true });
});

const deleteNotification = asyncHandler(async (req, res) => {
  const n = await Notification.findById(req.params.id);
  if (!n) {
    res.status(404);
    throw new Error("Bildiriş tapılmadı");
  }
  await n.deleteOne();
  res.status(200).json({ message: "Bildiriş silindi" });
});

module.exports = { createNotification, getNotifications, markSeen, deleteNotification };
