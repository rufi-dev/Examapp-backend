/*
 * The class an exam is written for, handed to the AI as context.
 *
 * 11 Oct 2026, Aynure Qənbərova: she named her class "11-Azerbaycan dili" and
 * asked the AI for "11 buraxilis modeline uygun". Her prompt never named the
 * subject, and the class name never reached the model, so an Azerbaijani
 * language class got a mixed paper: two grammar questions, then maths,
 * biology, chemistry, history and English. A teacher who has already told the
 * platform what the class is should not have to say it again in every prompt.
 *
 * So the class name now travels with the prompt, and the model is told to take
 * from it whatever the prompt leaves out. The prompt still wins when it names a
 * subject of its own.
 */
const mongoose = require("mongoose");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");

const isId = (v) => !!v && mongoose.isValidObjectId(String(v));

/*
 * The class name for this request, or "" when there is none to give.
 *
 * A saved exam names its own class. A new one (the route carries "new") has no
 * exam yet, so the builder sends the classId it was opened for. Either way the
 * class must belong to the caller: a classId from the browser is never trusted
 * to read someone else's class name. Never throws: no context is a fine answer.
 */
async function classNameFor(req) {
  try {
    const user = req?.user || {};
    const mine = user.role === "admin" ? {} : { owner: user._id };
    let classId = null;
    const examId = req?.params?.examId;
    if (isId(examId)) {
      const exam = await Exam.findOne({ _id: examId, ...mine }).select("class").lean();
      classId = exam?.class || null;
    }
    if (!classId && isId(req?.body?.classId)) classId = req.body.classId;
    if (!classId) return "";
    const cls = await Class.findOne({ _id: classId, ...mine }).select("name level").lean();
    if (!cls) return "";
    const name = String(cls.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (name) return name;
    // Old classes carry only a number.
    return Number.isFinite(cls.level) && cls.level > 0 ? `Sinif ${cls.level}` : "";
  } catch (e) {
    console.error("class context lookup failed:", e?.message);
    return "";
  }
}

// What the model reads about the class. Empty when there is no class.
function classContextLine(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  return [
    `SİNİF: «${n}» (müəllim bu imtahanı bu adlı sinif üçün yaradır).`,
    "Sinfin adında fənn və ya sinif səviyyəsi varsa və müəllimin təsviri onu demirsə, çatışmayanı sinfin adından götür və BÜTÜN sualları o fəndən yaz; başqa fənlərdən sual QATMA. " +
      "Məs. sinif «11-Azərbaycan dili», təsvir «11 buraxılış modelinə uyğun» → 11-ci sinif Azərbaycan dili buraxılış imtahanı, hamısı Azərbaycan dili sualları. " +
      "Müəllimin təsvirində fənn AÇIQ deyilibsə, təsvir üstündür.",
  ].join("\n");
}

// The prompt the model gets: the class first, then the teacher's own words.
function withClassContext(prompt, name) {
  const line = classContextLine(name);
  return line ? `${line}\n\nMÜƏLLİMİN TƏSVİRİ: ${prompt}` : prompt;
}

module.exports = { classNameFor, classContextLine, withClassContext };
