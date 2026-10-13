/*
 * What the support AI knows about the teacher it is talking to (owner,
 * 2026-10-13: "the AI should identify which stage the teacher is in"), on the
 * WhatsApp and the in-app chat alike: the plan, how much they have built, how
 * long since they signed up and were last seen, and a guess at the stage.
 * Counts only: no student names, no contents.
 *
 * Stages (the prompt's MÜƏLLİMİN MƏRHƏLƏSİ):
 *   A registered, nothing built yet
 *   B started and stalled (a class but no exam, or exams no student took)
 *   E working on the free plan (and whether a limit is near)
 *   F on a paid plan
 * C and D (sees no need / finds it too dear) can only be heard in the talk.
 */
const User = require("../models/userModel");

const PLAN_NAMES = { free: "Pulsuz", pro: "Pro", premium: "Premium" };
const daysSince = (d) => (d ? Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86400000)) : null);
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

function stageOf({ paid, classes, exams, students, taken, nearLimit }) {
  if (paid) return "F (ödənişli paketdədir: satışa sıxma, razılığını soruş, istifadə etmədiyi faydalı imkanı göstər)";
  if (!classes && !exams) return "A (qeydiyyatdan keçib, hələ heç nə yaratmayıb: məqsəd ilk addımı atdırmaq)";
  if (!exams || !students || !taken) return "B (başlayıb, amma yarımçıq qalıb: dəqiq harada ilişdiyini tap və həll et)";
  return nearLimit
    ? `E (pulsuz paketdə işləyir və limitə yaxındır: ${nearLimit}; Pro/Premium-un indi nə qatacağını göstər)`
    : "E (pulsuz paketdə işləyir: Pro/Premium-u yalnız ehtiyac yarananda, faydası ilə göstər)";
}

/*
 * One line for the prompt, or "" (not a teacher, not found, or anything fails:
 * the reply never waits on this). `userId` is the teacher's id.
 */
async function teacherContext(userId) {
  try {
    if (!userId) return "";
    const u = await User.findById(userId).select("role name plan planExpiresAt aiCredits examCreatesLeft createdAt lastActiveAt").lean();
    if (!u || u.role !== "teacher") return "";
    const { usageFor, effectivePlan } = require("./planLimits");
    const Exam = require("../models/examModel");
    const Result = require("../models/resultModel");
    const plan = effectivePlan(u);
    const [usage, examIds] = await Promise.all([usageFor(u), Exam.find({ owner: u._id, deletedAt: null }).distinct("_id")]);
    const taken = examIds.length ? await Result.countDocuments({ examId: { $in: examIds } }) : 0;
    const classes = usage.classes.used;
    const students = usage.students.used;
    const exams = examIds.length;
    const of = (n, limit) => (limit == null ? `${n}` : `${n} (limit ${limit})`);
    const near = [];
    if (plan === "free") {
      if (usage.examCreates.limit != null && usage.examCreates.left <= 1) near.push(`imtahan yaratmaq haqqı qalıb: ${usage.examCreates.left}/${usage.examCreates.limit}`);
      if (usage.students.limit != null && students >= usage.students.limit - 2) near.push(`şagird ${students}/${usage.students.limit}`);
      // (One class is the free plan's whole allowance, so a full class quota alone is no pressure.)
      if ((u.aiCredits || 0) < 10) near.push(`AI krediti ${u.aiCredits || 0}`);
    }
    const fn = firstName(u.name);
    const facts = [
      fn ? `adı ${fn}` : "",
      `${PLAN_NAMES[plan] || plan} paket${usage.expired ? " (ödənişli paketin vaxtı bitib)" : ""}`,
      `sinif ${of(classes, usage.classes.limit)}`,
      `şagird ${of(students, usage.students.limit)}`,
      `imtahan ${exams}`,
      `şagirdlərin verdiyi imtahan nəticəsi ${taken}`,
      `AI krediti ${u.aiCredits || 0}`,
      daysSince(u.createdAt) != null ? `qeydiyyat ${daysSince(u.createdAt)} gün əvvəl` : "",
      daysSince(u.lastActiveAt) != null ? `son giriş ${daysSince(u.lastActiveAt)} gün əvvəl` : "",
    ].filter(Boolean);
    const stage = stageOf({ paid: plan !== "free", classes, exams, students, taken, nearLimit: near.join(", ") });
    return `MÜƏLLİM HAQQINDA (yalnız sənin üçün; rəqəmləri müəllimə sadalama, lazım olanda bircə faktı yerində işlət): ${facts.join("; ")}.\nGÜMAN EDİLƏN MƏRHƏLƏ: ${stage}. Söhbətdə başqa şey görünsə (məs. qiyməti baha sayır və ya ehtiyac görmür), söhbətə görə davran.`;
  } catch {
    return "";
  }
}

module.exports = { teacherContext, _stageOf: stageOf };
