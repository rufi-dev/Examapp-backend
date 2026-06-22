// WhatsApp Cloud API helper (Meta WhatsApp Business Platform). DORMANT until
// WHATSAPP_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set in the environment — every
// entry point no-ops when unconfigured, so it is safe to ship before onboarding
// with Meta is finished. Uses Node 18+ global fetch (no extra dependency).
//
// IMPORTANT — business-initiated messages (like "a new exam was added") can only
// be sent as a PRE-APPROVED message TEMPLATE, not free text. Create a utility
// template in WhatsApp Manager whose body has THREE placeholders, e.g.:
//   "Yeni imtahan əlavə olundu: {{1}} ({{2}}). Başlamaq üçün: {{3}}"
// then set its name in WHATSAPP_TEMPLATE_NEW_EXAM (default "new_exam_alert").
//
// Required env:
//   WHATSAPP_TOKEN            - permanent (system-user) access token
//   WHATSAPP_PHONE_NUMBER_ID  - the sender's Phone Number ID
// Optional env:
//   WHATSAPP_GRAPH_VERSION    - Graph API version (default "v21.0")
//   WHATSAPP_TEMPLATE_NEW_EXAM- template name (default "new_exam_alert")
//   WHATSAPP_TEMPLATE_LANG    - template language code (default "az")
//   FRONTEND_URL              - used to build the exam link in the message
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v21.0";
const TEMPLATE_NEW_EXAM = process.env.WHATSAPP_TEMPLATE_NEW_EXAM || "new_exam_alert";
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || "az";
const FRONTEND_URL = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

const isWhatsAppConfigured = () => !!(TOKEN && PHONE_NUMBER_ID);

// Normalize a stored phone to E.164 ("+994501234567"). Handles local Azerbaijani
// formats entered without a country code. Returns null if it can't be trusted.
function toE164(raw) {
  let s = String(raw || "").trim();
  if (!s) return null;
  const hadPlus = s.startsWith("+");
  s = s.replace(/\D/g, "");
  if (!s) return null;
  if (!hadPlus) {
    if (s.startsWith("00")) s = s.slice(2); // 00994... -> 994...
    else if (s.startsWith("0")) s = "994" + s.slice(1); // 0XXXXXXXXX -> 994XXXXXXXXX
    else if (s.length === 9) s = "994" + s; // bare 9-digit subscriber -> +994
  }
  if (s.length < 8) return null; // "+994" placeholder / junk
  return "+" + s;
}

// Low-level Graph API POST. Never throws.
async function waApi(path, body) {
  if (!isWhatsAppConfigured()) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (json && json.error) {
      // eslint-disable-next-line no-console
      console.error("[WHATSAPP] API error:", json.error?.message || json.error);
    }
    return json;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] request failed:", e.message);
    return null;
  }
}

// Send a pre-approved template message with positional body parameters.
async function sendTemplate(toPhone, templateName, params = []) {
  const to = toE164(toPhone);
  if (!to) return null;
  return waApi(`${PHONE_NUMBER_ID}/messages`, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: TEMPLATE_LANG },
      components: params.length
        ? [
            {
              type: "body",
              parameters: params.map((t) => ({ type: "text", text: String(t ?? "-") })),
            },
          ]
        : [],
    },
  });
}

async function className(exam) {
  try {
    if (!exam?.class) return "";
    const c = await Class.findById(exam.class).select("name level");
    if (!c) return "";
    return c.name || (c.level != null ? String(c.level) : "");
  } catch {
    return "";
  }
}

// Notify the approved students of an exam's class that a new exam is available.
// Idempotent + lazy: re-reads the exam fresh, only fires when WhatsApp is
// configured, the exam is visible (not a draft), has questions, and hasn't been
// announced yet — then stamps studentsNotifiedAt so it never double-sends.
// Safe to call fire-and-forget from any controller.
async function notifyStudentsNewExam(examId) {
  try {
    if (!isWhatsAppConfigured()) return;
    const exam = await Exam.findById(examId);
    if (!exam) return;
    if (exam.hidden) return; // drafts don't notify
    if (exam.studentsNotifiedAt) return; // already announced
    if (!exam.questions) return; // not ready until it has questions
    if (!exam.class) return;

    const enrollments = await Enrollment.find({ class: exam.class, status: "approved" }).populate(
      "student",
      "phone whatsappOptIn"
    );
    const cname = await className(exam);
    const link = FRONTEND_URL ? `${FRONTEND_URL}/exam/details/${exam._id}` : "-";

    let sent = 0;
    for (const en of enrollments) {
      const s = en.student;
      if (!s || s.whatsappOptIn === false) continue;
      if (!toE164(s.phone)) continue;
      const r = await sendTemplate(s.phone, TEMPLATE_NEW_EXAM, [
        exam.name || "İmtahan",
        cname || "-",
        link,
      ]);
      if (r && !r.error) sent += 1;
    }

    exam.studentsNotifiedAt = new Date();
    await exam.save();
    // eslint-disable-next-line no-console
    console.log(`[WHATSAPP] new-exam notify: ${sent} student(s) for exam ${exam._id}`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[WHATSAPP] notifyStudentsNewExam failed:", e.message);
  }
}

module.exports = {
  isWhatsAppConfigured,
  toE164,
  sendTemplate,
  notifyStudentsNewExam,
};
