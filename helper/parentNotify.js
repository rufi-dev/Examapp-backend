// Parent WhatsApp notifications. Sent from the CLASS TEACHER's own linked number
// when they have one (Premium — see routes/whatsappRoute "teacher" surface), and
// otherwise from a ready ADMIN/system session (the pool the outreach job uses).
// Each event is gated per-class by class.notifyParents, which the teacher controls.
// Every function is fire-and-forget and never throws.
const wa = require("./whatsapp");
const User = require("../models/userModel");
const ClassModel = require("../models/classModel");
const ParentLink = require("../models/parentLinkModel");

const enabled = () => process.env.WHATSAPP_WEB_ENABLED === "true";
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => {
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? "" : `${pad(x.getHours())}:${pad(x.getMinutes())}`;
};
const ddmon = (d) => {
  const x = new Date(d);
  const M = ["Yan", "Fev", "Mar", "Apr", "May", "İyn", "İyl", "Avq", "Sen", "Okt", "Noy", "Dek"];
  return Number.isNaN(x.getTime()) ? "" : `${x.getDate()} ${M[x.getMonth()]}`;
};

// First ready admin/system session, or null when no WhatsApp is linked.
async function adminSender() {
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const keys = admins.flatMap((a) => [wa.accountKey(a._id, 1), wa.accountKey(a._id, 2)]);
  return wa.nextReadyOwner(keys);
}

// Who the message goes out from. A Premium teacher who linked their OWN number is
// preferred — parents then see their teacher's number rather than the platform's.
// Falls back to the system session whenever that teacher hasn't linked (or their
// session is down), so notifications never silently stop.
async function senderFor(ownerId) {
  if (ownerId) {
    const own = wa.readyOwners([wa.accountKey(ownerId, 1)]);
    if (own.length) return own[0];
  }
  return adminSender();
}

async function nameOf(studentId) {
  const u = await User.findById(studentId).select("name").lean();
  return u?.name || "Şagird";
}

// Core: send `text` to every linked parent of `studentId`. When `classId` is given,
// only sends if that class's master switch is on AND the per-event `category` flag
// (attendance | homework | exam | payment) is not turned off.
async function notifyParentsOf(studentId, classId, text, category) {
  try {
    if (!enabled() || !text) return;
    let owner = null;
    if (classId) {
      const cls = await ClassModel.findById(classId).select("notifyParents parentNotify owner").lean();
      if (!cls || !cls.notifyParents) return;
      if (category && cls.parentNotify && cls.parentNotify[category] === false) return;
      owner = cls.owner || null; // the teacher whose number we prefer to send from
    }
    // APPROVED links only. A pending request grants no data anywhere else (see
    // parentController.isLinked); without this filter someone who merely asked to
    // follow a child by email would receive their attendance, grades and debts.
    const parentIds = await ParentLink.find({ student: studentId, status: "approved" }).distinct("parent");
    if (!parentIds.length) return;
    const senderId = await senderFor(owner);
    if (!senderId) return; // no linked WhatsApp — silently skip
    const parents = await User.find({ _id: { $in: parentIds } }).select("phone").lean();
    for (const p of parents) {
      if (!wa.toDigits(p.phone)) continue;
      await wa.sendMessageFor(senderId, p.phone, text);
      await new Promise((r) => setTimeout(r, 1500)); // throttle, mirrors notifyStudentsNewExam
    }
  } catch (e) {
    console.warn("[PARENT-NOTIFY]", e?.message || e);
  }
}

// ── Event wrappers (each formats an Azerbaijani message, then fans out) ──────────

async function attendance(studentId, classId, { childName, className, lessonTitle, status, at } = {}) {
  const who = childName || (await nameOf(studentId));
  const head = status === "absent" ? `❌ ${who} — dərsə gəlmədi` : status === "late" ? `🕐 ${who} — dərsə gecikdi` : `✅ ${who} — dərsə gəldi`;
  const line2 = className || lessonTitle ? `📘 ${[className, lessonTitle].filter(Boolean).join(" · ")}` : null;
  const line3 = at && status !== "absent" ? `🕐 ${hhmm(at)}` : null;
  return notifyParentsOf(studentId, classId, [head, line2, line3].filter(Boolean).join("\n"), "attendance");
}

async function homeworkGraded(studentId, classId, { childName, title, grade, maxPoints } = {}) {
  const who = childName || (await nameOf(studentId));
  const score = grade != null ? `⭐ Qiymət: ${grade}${maxPoints != null ? `/${maxPoints}` : ""}` : null;
  const text = [`📝 ${who} — tapşırıq qiymətləndirildi`, title ? `📘 ${title}` : null, score].filter(Boolean).join("\n");
  return notifyParentsOf(studentId, classId, text, "homework");
}

async function examFinished(studentId, classId, { childName, examName, earnPoints, totalMarks } = {}) {
  const who = childName || (await nameOf(studentId));
  const score = earnPoints != null ? `⭐ Nəticə: ${earnPoints}${totalMarks != null ? `/${totalMarks}` : ""}` : null;
  const text = [`🎓 ${who} — imtahan nəticəsi hazırdır`, examName ? `📄 ${examName}` : null, score].filter(Boolean).join("\n");
  return notifyParentsOf(studentId, classId, text, "exam");
}

async function payment(studentId, classId, { childName, label, amount, paid, dueDate } = {}) {
  const who = childName || (await nameOf(studentId));
  const money = `${label ? `${label}: ` : ""}${amount != null ? `${amount} ₼` : ""}`.trim();
  const head = paid ? `💰 ${who} — ödəniş qeydə alındı (ödənilib)` : `💳 ${who} üçün yeni ödəniş`;
  const line3 = !paid && dueDate ? `📅 Son tarix: ${ddmon(dueDate)}` : null;
  return notifyParentsOf(studentId, classId, [head, money || null, line3].filter(Boolean).join("\n"), "payment");
}

module.exports = { notifyParentsOf, attendance, homeworkGraded, examFinished, payment };
