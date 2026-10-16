const mongoose = require("mongoose");
const Exam = require("../models/examModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const Question = require("../models/questionModel");

/*
 * What the support chat can DO for a teacher, not only say.
 *
 * The retired «AI köməkçi» robot (controllers/aiController.js, unmounted
 * 2026-10-13) could read the teacher's whole account and change an exam's
 * settings, and it opened a filled-in create form; a teacher told the owner
 * she could do much more with it than with the chat (2026-10-16). Those
 * abilities live here now, with two things the robot never had: every change
 * waits for the teacher's own «Təsdiq et» on a card under the reply, and every
 * change goes through the same guards as the app's own screens (owner, not in
 * the trash, consistent marks and dates, re-published so grading uses it).
 *
 * The model writes ONE marker at the end of its reply:
 *   [[action:{"type":"update_exam","examId":"…","changes":{…}}]]
 *   [[action:{"type":"move_exam","examId":"…","classId":"…"}]]
 *   [[action:{"type":"create_exam","classId":"…","prompt":"…"}]]
 * prepare() checks it against the teacher's own data and turns it into the
 * card (what changes, from what to what, in words); run() does it when the
 * teacher confirms, as the teacher. Nothing the model writes is trusted: ids
 * are looked up again, values are re-validated, and the summary on the card is
 * built here from the database, not copied from the model's text.
 */

const BAKU_MS = 4 * 3600 * 1000; // Azerbaijan: UTC+04:00, no daylight saving since 2016
const pad = (n) => String(n).padStart(2, "0");
function bakuTime(d) {
  if (!d) return "";
  const t = new Date(d).getTime();
  if (!Number.isFinite(t)) return "";
  const b = new Date(t + BAKU_MS);
  return `${pad(b.getUTCDate())}.${pad(b.getUTCMonth() + 1)}.${b.getUTCFullYear()} ${pad(b.getUTCHours())}:${pad(b.getUTCMinutes())}`;
}
const yesNo = (v) => (v ? "bəli" : "xeyr");
const minutes = (sec) => Math.round((Number(sec) || 0) / 60);
const isId = (v) => typeof v === "string" && mongoose.isValidObjectId(v);
const quote = (s) => `«${String(s || "").trim() || "Adsız"}»`;

function todayLine(now = new Date()) {
  const [date, time] = bakuTime(now).split(" ");
  return `BUGÜN: ${date}, saat ${time} (Bakı vaxtı, UTC+04:00).`;
}

function examStatus(e, questions, now = Date.now()) {
  if (e.provisional) return "Qaralama (dərc olunmayıb)";
  if (e.blockedByPlan) return "Bloklanıb (paket limiti)";
  if (e.hidden) return "Gizli";
  if (!questions) return "Sual yoxdur";
  if (e.startDate && new Date(e.startDate).getTime() > now) return "Gələcək";
  if (e.endDate && new Date(e.endDate).getTime() < now) return "Bitib";
  return "Aktiv";
}

const MAX_CLASSES = 30;
const MAX_EXAMS = 80;

/*
 * The teacher's own classes and exams, in words, for the prompt: what the
 * robot's get_account_overview returned, minus anything a student wrote and
 * minus the passwords themselves (only whether one is set). Ids are there for
 * the markers only; the prompt tells the model never to show them.
 */
async function accountBrief(userId) {
  if (!isId(String(userId || ""))) return "";
  const owner = new mongoose.Types.ObjectId(String(userId));
  const [classes, exams] = await Promise.all([
    Class.find({ owner, deletedAt: null }).sort({ createdAt: -1 }).limit(MAX_CLASSES).select("name level joinCode").lean(),
    Exam.find({ owner, deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(MAX_EXAMS)
      .select("name class questions startDate endDate duration totalMarks passingMarks maxTry negativeMarking antiCheat password showScore showCorrectAnswers revealAfterEnd shuffleOptions shuffleQuestions hidden provisional blockedByPlan")
      .lean(),
  ]);
  if (!classes.length && !exams.length) return `${todayLine()}\nMÜƏLLİMİN HESABI: hələ sinfi və imtahanı yoxdur.`;

  const classIds = classes.map((c) => c._id);
  const qIds = exams.map((e) => e.questions).filter(Boolean);
  const [enr, qs] = await Promise.all([
    classIds.length
      ? Enrollment.aggregate([{ $match: { class: { $in: classIds }, status: "approved" } }, { $group: { _id: "$class", n: { $sum: 1 } } }])
      : [],
    qIds.length
      ? Question.aggregate([{ $match: { _id: { $in: qIds } } }, { $project: { n: { $size: { $ifNull: ["$correctAnswers", []] } } } }])
      : [],
  ]);
  const students = new Map(enr.map((r) => [String(r._id), r.n]));
  const qCount = new Map(qs.map((r) => [String(r._id), r.n]));

  const line = (e) => {
    const n = qCount.get(String(e.questions)) || 0;
    const parts = [
      examStatus(e, n),
      `${n} sual`,
      `başlama ${bakuTime(e.startDate) || "yoxdur"}`,
      `bitmə ${bakuTime(e.endDate) || "yoxdur"}`,
      `${minutes(e.duration)} dəq`,
      `${e.totalMarks} bal, keçid ${e.passingMarks}`,
      `cəhd ${e.maxTry ? e.maxTry : "limitsiz"}`,
      `neqativ ${yesNo(e.negativeMarking)}`,
      `şifrə ${e.password ? "var" : "yoxdur"}`,
      `köçürməyə qarşı qoruma ${yesNo(e.antiCheat)}`,
      `balı göstər ${yesNo(e.showScore !== false)}`,
      `düzgün cavabları göstər ${e.showCorrectAnswers ? (e.revealAfterEnd ? "bitdikdən sonra" : "dərhal") : "xeyr"}`,
      `variantları qarışdır ${yesNo(e.shuffleOptions)}`,
      `sualları qarışdır ${yesNo(e.shuffleQuestions)}`,
    ];
    return `  – ${quote(e.name)} [ID ${e._id}]: ${parts.join("; ")}`;
  };

  const byClass = new Map();
  for (const e of exams) {
    const k = String(e.class || "");
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k).push(e);
  }
  const out = [todayLine(), "MÜƏLLİMİN HESABI (yalnız bu müəllimin; [ID] yalnız [[action]] üçündür, mətndə yazma):"];
  for (const c of classes) {
    const list = byClass.get(String(c._id)) || [];
    byClass.delete(String(c._id));
    const name = c.name && String(c.name).trim() ? c.name : c.level != null ? `${c.level} sinif` : "Sinif";
    out.push(`• Sinif ${quote(name)} [ID ${c._id}]: qoşulma kodu ${c.joinCode || "yoxdur"}, ${students.get(String(c._id)) || 0} şagird, ${list.length} imtahan`);
    out.push(...list.map(line));
  }
  // Exams of a class that is in the trash or beyond the list above.
  const rest = [...byClass.values()].flat();
  if (rest.length) {
    out.push("• Başqa (silinmiş və ya siyahıda olmayan) sinifdəki imtahanlar:");
    out.push(...rest.map(line));
  }
  if (classes.length >= MAX_CLASSES || exams.length >= MAX_EXAMS) out.push(`(Yalnız son ${MAX_CLASSES} sinif və ${MAX_EXAMS} imtahan göstərilir.)`);
  return out.join("\n");
}

/*
 * The fields a chat change may touch, how each is read from the model, how
 * it is called on the screen (the labels the prompt uses), and how a value
 * reads on the card.
 */
const FIELDS = {
  name: {
    label: "Ad",
    read: (v) => (typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 120 ? { name: v.trim() } : null),
    show: (e) => quote(e.name),
  },
  startDate: { label: "Başlama", read: (v) => readDate("startDate", v), show: (e) => bakuTime(e.startDate) || "yoxdur" },
  endDate: { label: "Bitmə", read: (v) => readDate("endDate", v), show: (e) => bakuTime(e.endDate) || "yoxdur" },
  durationMinutes: {
    label: "Müddət",
    read: (v) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 1 && n <= 1440 ? { duration: n * 60 } : null;
    },
    show: (e) => `${minutes(e.duration)} dəq`,
  },
  totalMarks: { label: "Ümumi bal", read: (v) => num("totalMarks", v, 1, 10000), show: (e) => `${e.totalMarks}` },
  passingMarks: { label: "Keçid balı", read: (v) => num("passingMarks", v, 0, 10000), show: (e) => `${e.passingMarks}` },
  maxTry: {
    label: "Cəhd sayı",
    read: (v) => {
      const n = Math.round(Number(v));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { maxTry: n } : null;
    },
    show: (e) => (e.maxTry ? `${e.maxTry}` : "limitsiz"),
  },
  negativeMarking: { label: "Neqativ qiymətləndirmə", read: (v) => bool("negativeMarking", v), show: (e) => yesNo(e.negativeMarking) },
  antiCheat: { label: "Köçürməyə qarşı qoruma", read: (v) => bool("antiCheat", v), show: (e) => yesNo(e.antiCheat) },
  showScore: { label: "Balı göstər", read: (v) => bool("showScore", v), show: (e) => yesNo(e.showScore !== false) },
  showCorrectAnswers: { label: "Düzgün cavabları göstər", read: (v) => bool("showCorrectAnswers", v), show: (e) => yesNo(e.showCorrectAnswers) },
  revealAfterEnd: {
    label: "Düzgün cavablar",
    read: (v) => bool("revealAfterEnd", v),
    show: (e) => (e.revealAfterEnd ? "imtahan bitdikdən sonra" : "dərhal"),
  },
  shuffleOptions: { label: "Variantları qarışdır", read: (v) => bool("shuffleOptions", v), show: (e) => yesNo(e.shuffleOptions) },
  shuffleQuestions: { label: "Sualları qarışdır", read: (v) => bool("shuffleQuestions", v), show: (e) => yesNo(e.shuffleQuestions) },
  password: {
    label: "Şifrə",
    read: (v) => (typeof v === "string" && v.length <= 50 ? { password: v.trim() } : null),
    // The card shows whether there is one, never the old one.
    show: (e) => (e.password ? "var" : "yoxdur"),
    showNew: (v) => (v ? `«${v}»` : "yoxdur"),
  },
  hidden: { label: "Şagirdlər görür", read: (v) => bool("hidden", v), show: (e) => (e.hidden ? "xeyr (gizli)" : "bəli") },
};
function readDate(key, v) {
  if (v === "" || v === null) return { [key]: null };
  if (typeof v !== "string") return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? { [key]: new Date(t) } : null;
}
function num(key, v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? { [key]: n } : null;
}
function bool(key, v) {
  if (v === true || v === "true") return { [key]: true };
  if (v === false || v === "false") return { [key]: false };
  return null;
}
const same = (a, b) => (a instanceof Date || b instanceof Date ? (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null) : String(a ?? "") === String(b ?? ""));
const EXAM_FIELDS = "name owner class questions startDate endDate duration totalMarks passingMarks maxTry negativeMarking antiCheat password showScore showCorrectAnswers revealAfterEnd shuffleOptions shuffleQuestions hidden provisional deletedAt";

// The exam as the merged result would leave it: nothing impossible gets saved.
function inconsistency(e) {
  if (Number(e.passingMarks) > Number(e.totalMarks)) return "keçid balı ümumi baldan çox ola bilməz";
  if (e.startDate && e.endDate) {
    const s = new Date(e.startDate).getTime();
    const end = new Date(e.endDate).getTime();
    if (s >= end) return "bitmə vaxtı başlamadan sonra olmalıdır";
    if (end - s < (Number(e.duration) || 0) * 1000) return "başlama ilə bitmə arası imtahanın müddətindən qısa ola bilməz";
  }
  return "";
}

async function ownExam(user, examId) {
  if (!isId(examId)) return { why: "imtahan tapılmadı" };
  const exam = await Exam.findById(examId).select(EXAM_FIELDS).lean();
  if (!exam) return { why: "imtahan tapılmadı" };
  if (user.role !== "admin" && exam.owner && String(exam.owner) !== String(user._id)) return { why: "bu imtahan sizə aid deyil" };
  if (exam.deletedAt) return { why: "imtahan zibil qutusundadır" };
  return { exam };
}
async function ownClass(user, classId) {
  if (!isId(classId)) return { why: "sinif tapılmadı" };
  const cls = await Class.findOne({ _id: classId, deletedAt: null }).select("name level owner").lean();
  if (!cls) return { why: "sinif tapılmadı" };
  if (user.role !== "admin" && String(cls.owner) !== String(user._id)) return { why: "bu sinif sizə aid deyil" };
  return { cls };
}
const classTitle = (c) => quote(c?.name && String(c.name).trim() ? c.name : c?.level != null ? `${c.level} sinif` : "Sinif");

/*
 * Read an update's changes against the exam as it is now: only the fields that
 * really change, each as "label: old → new".
 */
function diffExam(exam, changes) {
  const set = {};
  const lines = [];
  for (const [key, raw] of Object.entries(changes || {})) {
    const f = FIELDS[key];
    if (!f) continue;
    const got = f.read(raw);
    if (!got) return { why: `«${f.label}» üçün dəyər anlaşılmadı` };
    const [[field, value]] = Object.entries(got);
    if (same(exam[field], value)) continue;
    set[field] = value;
    const after = f.showNew ? f.showNew(value) : f.show({ ...exam, [field]: value });
    lines.push(`${f.label}: ${f.show(exam)} → ${after}`);
  }
  return { set, lines };
}

const ACTION_RE = /\[\[action:(\{[\s\S]*?\})\]\]/;
// A reply that tells the teacher to press a card's button but carries no card.
const promisesCard = (text) => !ACTION_RE.test(String(text || "")) && /hazırladım|«Təsdiq et»|«Yaratma ekranını aç»/i.test(String(text || ""));
const ACTION_ALL_RE = /\[\[action:[\s\S]*?\]\]/g;

// The reply without its marker, and the marker's JSON (the first one only).
function splitAction(text) {
  const s = String(text || "");
  const m = s.match(ACTION_RE);
  const clean = s.replace(ACTION_ALL_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text: clean, raw: m ? m[1] : null };
}

/*
 * The marker, checked against THIS teacher's data, as the card to show:
 * { ok:true, action:{ kind, params, title, lines } } or { ok:false, why }.
 */
async function prepare(raw, user) {
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    return { ok: false, why: "əməliyyat oxunmadı" };
  }
  const kind = a && a.type;
  if (kind === "update_exam") {
    const { exam, why } = await ownExam(user, a.examId);
    if (!exam) return { ok: false, why };
    const { set, lines, why: bad } = diffExam(exam, a.changes);
    if (bad) return { ok: false, why: bad };
    if (!lines.length) return { ok: false, why: "bu ayarlar artıq belədir" };
    const broken = inconsistency({ ...exam, ...set });
    if (broken) return { ok: false, why: broken };
    const params = { examId: String(exam._id), changes: {} };
    for (const key of Object.keys(a.changes || {})) if (FIELDS[key]) params.changes[key] = a.changes[key];
    return { ok: true, action: { kind, params, title: `${quote(exam.name)} imtahanını dəyiş`, lines } };
  }
  if (kind === "move_exam") {
    const { exam, why } = await ownExam(user, a.examId);
    if (!exam) return { ok: false, why };
    const { cls, why: noClass } = await ownClass(user, a.classId);
    if (!cls) return { ok: false, why: noClass };
    if (String(exam.class) === String(cls._id)) return { ok: false, why: "imtahan artıq bu sinifdədir" };
    const from = exam.class ? await Class.findById(exam.class).select("name level").lean() : null;
    return {
      ok: true,
      action: {
        kind,
        params: { examId: String(exam._id), classId: String(cls._id) },
        title: `${quote(exam.name)} imtahanını başqa sinfə köçür`,
        lines: [`Sinif: ${from ? classTitle(from) : "yoxdur"} → ${classTitle(cls)}`, "Nəticələr və suallar imtahanla birlikdə gedir; imtahanı yalnız yeni sinfin şagirdləri görəcək."],
      },
    };
  }
  if (kind === "create_exam") {
    const { cls, why } = await ownClass(user, a.classId);
    if (!cls) return { ok: false, why };
    const prompt = typeof a.prompt === "string" ? a.prompt.trim().slice(0, 1500) : "";
    if (prompt.length < 5) return { ok: false, why: "imtahanın mövzusu yazılmayıb" };
    return {
      ok: true,
      action: {
        kind,
        params: { classId: String(cls._id), prompt },
        title: `${classTitle(cls)} sinfi üçün yeni imtahan`,
        lines: [`Təsvir: ${prompt}`, "Yaratma ekranı bu təsvirlə açılır; yoxlayıb «Sualları hazırla» basın (10 kredit)."],
      },
    };
  }
  return { ok: false, why: "bu əməliyyatı edə bilmirəm" };
}

/*
 * Do a confirmed action, as the teacher who confirmed it. Everything is
 * checked again: the exam may have changed since the card was made.
 * → { ok, message, link? }
 */
async function run(action, user) {
  const { kind, params } = action || {};
  if (kind === "update_exam") {
    const { exam, why } = await ownExam(user, params?.examId);
    if (!exam) return { ok: false, message: `Alınmadı: ${why}.` };
    const { set, lines, why: bad } = diffExam(exam, params.changes);
    if (bad) return { ok: false, message: `Alınmadı: ${bad}.` };
    if (!lines.length) return { ok: true, message: "Dəyişiləcək bir şey qalmadı: ayarlar artıq belədir.", link: `/exam/edit/${exam._id}` };
    const broken = inconsistency({ ...exam, ...set });
    if (broken) return { ok: false, message: `Alınmadı: ${broken}.` };
    const saved = await Exam.updateOne({ _id: exam._id, deletedAt: null, purging: { $ne: true } }, { $set: set });
    if (saved.matchedCount !== 1) return { ok: false, message: "Alınmadı: imtahan bu vaxt dəyişdi, yenidən cəhd edin." };
    const quiz = require("../controllers/quizController");
    // A settings change reaches grading only through a new version, as on «Yadda saxla».
    const settings = Object.keys(set).some((k) => k !== "hidden");
    if (settings && !exam.provisional) await quiz.republishExam(exam._id);
    // Shown again = announced again, as the card's eye button does.
    if (set.hidden === false) require("../helper/whatsapp").notifyStudentsNewExam(exam._id, { force: true }).catch(() => {});
    console.info(`[CHAT-ACTION] update_exam user=${user._id} exam=${exam._id} fields=${Object.keys(set).join(",")}`);
    // The card already lists what changed, from what to what.
    return { ok: true, message: "Edildi.", link: `/exam/edit/${exam._id}` };
  }
  if (kind === "move_exam") {
    const { moveExam } = require("./moveExam");
    const out = await moveExam(user, params?.examId, params?.classId);
    if (out.status !== 200) return { ok: false, message: `Alınmadı: ${out.body?.message || "köçürülmədi"}.` };
    console.info(`[CHAT-ACTION] move_exam user=${user._id} exam=${params.examId}`);
    return { ok: true, message: `Köçürüldü: indi ${quote(out.body.class?.name)} sinfindədir.`, link: `/exam/${out.body.class?._id}` };
  }
  if (kind === "create_exam") {
    // Nothing is created here: the card opens the composer with the description in it.
    const { cls, why } = await ownClass(user, params?.classId);
    if (!cls) return { ok: false, message: `Alınmadı: ${why}.` };
    return { ok: true, message: "Yaratma ekranı açıldı.", link: `/class/${cls._id}/new-exam` };
  }
  return { ok: false, message: "Bu əməliyyatı edə bilmirəm." };
}

// The prompt's section on actions (the in-app chat only; WhatsApp has no cards).
const ACTIONS_NOTE = `ƏMƏLİYYATLAR (yalnız saytdakı söhbətdə): müəllimin hesabında bəzi işləri onun yerinə HAZIRLAYA bilərsən. Cavabın ən sonunda ayrıca sətirdə [[action:{...}]] yazırsan; tətbiq bunu kart kimi göstərir: nə dəyişəcək və «Təsdiq et» / «Ləğv et». Müəllim «Təsdiq et» basmayınca HEÇ NƏ dəyişmir. Ona görə "dəyişdim", "etdim", "köçürdüm" YAZMA; "hazırladım, aşağıda yoxlayıb «Təsdiq et» basın" yaz.
Nə edə bilərsən:
1) İmtahanın ayarlarını dəyişmək: [[action:{"type":"update_exam","examId":"ID","changes":{...}}]]. changes-də YALNIZ dəyişən sahələr: "name" (ad), "startDate" və "endDate" (ISO, Bakı vaxtı ilə, məs. "2026-10-20T23:59:00+04:00"; "" tarixi silir), "durationMinutes", "totalMarks", "passingMarks", "maxTry" (0 = limitsiz), "negativeMarking", "antiCheat" (köçürməyə qarşı qoruma), "showScore" (balı göstər), "showCorrectAnswers" (düzgün cavabları göstər), "revealAfterEnd" (true = cavablar imtahan bitdikdən sonra, false = dərhal), "shuffleOptions" (variantları qarışdır), "shuffleQuestions" (sualları qarışdır), "password" (yeni şifrə; "" şifrəni götürür), "hidden" (true = gizlət, false = şagirdlərə göstər).
2) İmtahanı başqa sinfə köçürmək: [[action:{"type":"move_exam","examId":"ID","classId":"ID"}]]. Nəticələr və suallar imtahanla gedir; imtahanı yalnız yeni sinfin şagirdləri görür.
3) Yeni imtahana başlamaq: [[action:{"type":"create_exam","classId":"ID","prompt":"..."}]]. Kart bu sinif üçün yaratma ekranını açır və «Nə haqqında imtahan olsun?» xanasına prompt-u yazır; müəllim yoxlayıb «Sualları hazırla» basır (10 kredit). prompt-a fənni, sinfi, mövzunu, sual sayını və çətinliyi yaz.
Qaydalar:
- Yalnız müəllim bunu açıq istəyəndə və ya sən təklif edib o razılaşanda. Hansı imtahan və ya sinif olduğu aydın deyilsə (ad deyilməyib, və ya bir neçə imtahan eyni dərəcədə uyğundur), uyğun gələnləri sadalayıb soruş və işarə yazma. Kartın başlığında imtahanın adı görünür, müəllim yanlışdırsa «Ləğv et» basar.
- "Hazırladım" yazırsansa, cavabın sonunda [[action:…]] MÜTLƏQ olmalıdır: işarə olmadan kart çıxmır və müəllim heç nə görmür. Hazırlamırsansa, "hazırladım" və «Təsdiq et» yazma.
- Yeni imtahan üçün çətinlik və ya sual tipi deyilməyibsə soruşma: "orta çətinlik" yaz; müəllim təsviri yaratma ekranında dəyişə bilər. Tarix "sabah", "cümə günü" kimi deyiləndə BUGÜN sətrinə görə hesabla; saat deyilməyibsə bitmə üçün 23:59 götür.
- ID-ləri YALNIZ «MÜƏLLİMİN HESABI» siyahısından götür. ID-ləri, JSON-u və işarəni mətndə göstərmə və izah etmə. Bir cavabda ən çox bir [[action:…]]; olanda [[steps:…]] yazma.
- Mətndə nəyin dəyişəcəyini bir cümlə ilə de (məs. "«Kəsrlər» imtahanının müddətini 60 dəqiqə etməyi hazırladım, aşağıda «Təsdiq et» basın."). Qalanını kart göstərir. Yeni imtahan kartının düyməsi «Yaratma ekranını aç»-dır, «Təsdiq et» deyil (məs. "9-A üçün biologiya imtahanının təsvirini yazdım, aşağıda «Yaratma ekranını aç» basın, yoxlayıb «Sualları hazırla» ilə başlayın.").
- Edə bilmədiklərin (sualları dəyişmək, imtahanı və ya sinfi silmək, şagird əlavə etmək və ya çıxarmaq, nəticələri dəyişmək, ödəniş, paket): bunları özün edə bilmədiyini de və necə ediləcəyini izah et.
- Hesab barədə suala (qoşulma kodu, neçə şagird, imtahan nə vaxt bitir, şifrə varmı, hansı imtahan gizlidir) «MÜƏLLİMİN HESABI»ndan dəqiq cavab ver. Şifrənin özünü bilmirsən, yalnız olub-olmadığını.
KARTLAR VƏ KEÇMİŞ MESAJLAR:
- Söhbətdə sənin mesajlarının sonunda ⟦sistem: …⟧ qeydi ola bilər: o mesajın altında göstərilən kartı və onun taleyini SİSTEM yazır. "müəllim TƏSDİQLƏDİ, dəyişiklik edildi" = dəyişiklik həqiqətən olub; "LƏĞV ETDİ" = olmayıb və o kart bağlıdır (onda «Təsdiq et» basmaq olmur; müəllim yenə istəsə yeni kart hazırla); "hələ təsdiqləməyib" = kart gözləyir, «Təsdiq et» basmağı xatırlada bilərsən. Bu qeydi heç vaxt özün yazma.
- «MÜƏLLİMİN HESABI» İNDİKİ vəziyyətdir (bu an bazadan oxunub): söhbət və kartlar bir rəqəm, hesab başqa rəqəm deyirsə, HESAB doğrudur — sonradan başqa yerdə dəyişdirilmiş ola bilər. Hesabda artıq olan dəyərə dəyişiklik kartı HAZIRLAMA: "artıq … dir" de.
- Əvvəlki mesajında yazdığın rəqəm indi fərqlidirsə, səbəb adətən təsdiqlənmiş kartdır və ya müəllimin özü dəyişib: bu SƏHV DEYİL. Keçmiş mesajlarını "düzəltmə", səbəb uydurma, üzr istəmə; lazımdırsa sadəcə indiki vəziyyəti bir cümlə ilə de.
- Üzr yalnız müəllim sənin konkret səhvini göstərəndə istə, bir dəfə və qısa.
- Müəllim "sağ ol", "aha", "oldu", "əla" yazanda qısa cavab ver (məs. "Rica edirəm! Başqa nə lazımdır?"); keçmiş barədə izah vermə.`;

module.exports = { accountBrief, splitAction, promisesCard, prepare, run, ACTIONS_NOTE, todayLine, bakuTime, _diffExam: diffExam, _inconsistency: inconsistency };
