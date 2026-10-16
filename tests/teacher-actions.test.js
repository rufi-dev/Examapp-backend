/* eslint-env node */
/*
 * What the support chat can DO (owner, 2026-10-16: "copy the robot's functions
 * to the chat AI"), and the exam card's «Sinfi dəyiş» it shares a core with.
 *
 * Against a real (in-memory) database: the account the prompt is given, every
 * action prepared, refused and run, the confirm endpoint's one-time decision,
 * and the move's class counts. Publishing and WhatsApp are stubbed.
 */
process.env.NODE_ENV = "test";

const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

// Publishing a version and announcing an exam are other tests' business.
let republished = 0;
let announced = 0;
const stub = (rel, exports) => {
  const file = require.resolve(path.join(__dirname, "..", rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
};
stub("controllers/quizController", { republishExam: async () => { republished += 1; return { ok: true }; } });
stub("helper/whatsapp", { notifyStudentsNewExam: async () => { announced += 1; } });

const User = require("../models/userModel");
const Class = require("../models/classModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const Enrollment = require("../models/enrollmentModel");
const Message = require("../models/messageModel");
const A = require("../helper/teacherActions");
const { moveExam } = require("../helper/moveExam");

const oid = () => new mongoose.Types.ObjectId();

(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  try {
    const teacher = { _id: oid(), role: "teacher" };
    const other = { _id: oid(), role: "teacher" };
    const [nineA, nineB, trashed, theirs] = await Class.insertMany([
      { name: "9-A", owner: teacher._id, joinCode: "ABC234", examCount: 2 },
      { name: "9-B", owner: teacher._id, joinCode: "XYZ789", examCount: 0 },
      { name: "Köhnə", owner: teacher._id, joinCode: "OLD222", deletedAt: new Date() },
      { name: "Başqasının", owner: other._id, joinCode: "THE333" },
    ]);
    await Enrollment.insertMany([
      { student: oid(), class: nineA._id, status: "approved" },
      { student: oid(), class: nineA._id, status: "approved" },
      { student: oid(), class: nineA._id, status: "pending" },
    ]);
    const base = { duration: 2700, totalMarks: 100, passingMarks: 50, price: 0, owner: teacher._id, mode: "structured" };
    const [kesr, binned, foreign] = await Exam.insertMany([
      { ...base, name: "Kəsrlər", class: nineA._id, password: "gizli123", startDate: new Date("2026-10-16T06:00:00Z"), endDate: new Date("2026-10-20T19:59:00Z") },
      { ...base, name: "Silinmiş", class: nineA._id, deletedAt: new Date() },
      { ...base, name: "Onun imtahanı", class: theirs._id, owner: other._id },
    ]);
    const q = await Question.create({ exam: kesr._id, correctAnswers: [{ type: "Cm", answer: "a" }, { type: "Cm", answer: "b" }] });
    await Exam.updateOne({ _id: kesr._id }, { $set: { questions: q._id } });

    console.log("the account the chat is given");
    const brief = await A.accountBrief(teacher._id);
    ok("today, in Baku time", /^BUGÜN: \d\d\.\d\d\.\d{4}, saat \d\d:\d\d \(Bakı vaxtı, UTC\+04:00\)\./.test(brief), brief.split("\n")[0]);
    ok("the class with its join code and APPROVED students only", /Sinif «9-A» \[ID [a-f0-9]{24}\]: qoşulma kodu ABC234, 2 şagird, 1 imtahan/.test(brief), brief);
    ok("the exam with its id, questions, Baku dates and settings", /«Kəsrlər» \[ID [a-f0-9]{24}\]: .*2 sual; başlama 16\.10\.2026 10:00; bitmə 20\.10\.2026 23:59; 45 dəq; 100 bal, keçid 50/.test(brief), brief);
    ok("whether a password is set, never the password", /şifrə var/.test(brief) && !brief.includes("gizli123"));
    ok("nothing in the trash, nothing of another teacher's", !brief.includes("Silinmiş") && !brief.includes("Köhnə") && !brief.includes("Onun imtahanı") && !brief.includes("Başqasının"));
    ok("a teacher with nothing yet is told so", /hələ sinfi və imtahanı yoxdur/.test(await A.accountBrief(oid())));

    const read = (rel) => require("fs").readFileSync(path.join(__dirname, "..", rel), "utf8");
    console.log("the marker");
    const s = A.splitAction('Hazırladım.\n[[action:{"type":"move_exam","examId":"x","classId":"y"}]]');
    ok("comes off the text, its JSON kept", s.text === "Hazırladım." && JSON.parse(s.raw).type === "move_exam");
    ok("a reply without one is left alone", A.splitAction("Salam").raw === null);
    ok("a reply promising a card without one is caught", A.promisesCard("Müddəti 60 dəqiqə etməyi hazırladım, aşağıda «Təsdiq et» basın.") && A.promisesCard("Aşağıda «Yaratma ekranını aç» basın."));
    ok("…not one that carries its card, nor a how-to that names «Təsdiq et və davam et»", !A.promisesCard('Hazırladım, «Təsdiq et» basın.\n[[action:{"type":"move_exam"}]]') && !A.promisesCard("Sonra «Təsdiq et və davam et» düyməsinə basın."));
    ok("the reply is asked for again, once, and the controller owns up if it still lacks the card", /promisesCard\(text\)/.test(read("services/chatAssistant.js")) && /CARD_NOTE/.test(read("services/chatAssistant.js")) && /Bağışlayın, kart hazırlanmadı/.test(read("controllers/chatController.js")));

    console.log("an exam's settings");
    const upd = (changes, examId = String(kesr._id)) => A.prepare(JSON.stringify({ type: "update_exam", examId, changes }), teacher);
    let r = await upd({ durationMinutes: 60, endDate: "2026-10-25T23:59:00+04:00" });
    ok("a change becomes a card: old → new, in the screen's words", r.ok && r.action.title === "«Kəsrlər» imtahanını dəyiş" && r.action.lines.includes("Müddət: 45 dəq → 60 dəq") && r.action.lines.includes("Bitmə: 20.10.2026 23:59 → 25.10.2026 23:59"), JSON.stringify(r));
    r = await upd({ durationMinutes: 45, maxTry: 0 });
    ok("nothing really changing is refused", !r.ok && r.why === "bu ayarlar artıq belədir", JSON.stringify(r));
    r = await upd({ passingMarks: 150 });
    ok("an impossible exam is refused", !r.ok && /keçid balı ümumi baldan çox/.test(r.why), JSON.stringify(r));
    r = await upd({ endDate: "2026-10-16T10:20:00+04:00" });
    ok("a window shorter than the exam is refused", !r.ok && /müddətindən qısa/.test(r.why), JSON.stringify(r));
    r = await upd({ durationMinutes: "çox" });
    ok("a value it cannot read is refused by name", !r.ok && /«Müddət»/.test(r.why), JSON.stringify(r));
    r = await upd({ hidden: true }, String(foreign._id));
    ok("another teacher's exam is refused", !r.ok && /sizə aid deyil/.test(r.why));
    r = await upd({ hidden: true }, String(binned._id));
    ok("an exam in the trash is refused", !r.ok && /zibil qutusundadır/.test(r.why));
    r = await upd({ password: "yeni" });
    ok("a new password shows on the card, the old one never", r.ok && r.action.lines[0] === "Şifrə: var → «yeni»", JSON.stringify(r));

    r = await upd({ durationMinutes: 60, shuffleOptions: true });
    let out = await A.run(r.action, teacher);
    let now = await Exam.findById(kesr._id).lean();
    ok("confirmed: saved", out.ok && now.duration === 3600 && now.shuffleOptions === true, JSON.stringify(out));
    ok("…and re-published, so grading uses it", republished === 1);
    ok("…and says so, with the way to the settings", out.message === "Edildi." && out.link === `/exam/edit/${kesr._id}`, out.message);
    out = await A.run(r.action, teacher);
    ok("the same card again changes nothing more", out.ok && /artıq belədir/.test(out.message) && republished === 1, out.message);
    r = await upd({ hidden: true });
    await A.run(r.action, teacher);
    r = await upd({ hidden: false });
    out = await A.run(r.action, teacher);
    ok("hiding and showing do not re-publish; showing announces again", out.ok && republished === 1 && announced === 1);
    out = await A.run({ kind: "update_exam", params: { examId: String(kesr._id), changes: { durationMinutes: 50 } } }, other);
    ok("run checks the owner again", !out.ok && /sizə aid deyil/.test(out.message));

    console.log("moving an exam");
    const mv = (classId, examId = String(kesr._id), who = teacher) => A.prepare(JSON.stringify({ type: "move_exam", examId, classId }), who);
    r = await mv(String(nineB._id));
    ok("the card names both classes and what goes along", r.ok && r.action.lines[0] === "Sinif: «9-A» → «9-B»" && /Nəticələr və suallar/.test(r.action.lines[1]), JSON.stringify(r));
    ok("into the class it is in: refused", !(await mv(String(nineA._id))).ok);
    ok("into a class in the trash: refused", (await mv(String(trashed._id))).why === "sinif tapılmadı");
    ok("into another teacher's class: refused", /sizə aid deyil/.test((await mv(String(theirs._id))).why));
    out = await A.run(r.action, teacher);
    now = await Exam.findById(kesr._id).lean();
    const [a2, b2] = await Promise.all([Class.findById(nineA._id).lean(), Class.findById(nineB._id).lean()]);
    ok("confirmed: the exam is in 9-B", out.ok && String(now.class) === String(nineB._id) && out.link === `/exam/${nineB._id}`, JSON.stringify(out));
    ok("…and the class counts moved with it", a2.examCount === 1 && b2.examCount === 1, `${a2.examCount}/${b2.examCount}`);
    let m = await moveExam(teacher, String(kesr._id), String(nineB._id));
    ok("the card's endpoint: the same class again is a no-op", m.status === 200 && m.body.unchanged === true);
    m = await moveExam(other, String(kesr._id), String(theirs._id));
    ok("…another teacher cannot move it", m.status === 403);
    m = await moveExam(teacher, String(binned._id), String(nineB._id));
    ok("…an exam in the trash cannot move", m.status === 403 && m.body.reason === "archived");
    m = await moveExam({ _id: oid(), role: "admin" }, String(kesr._id), String(nineA._id));
    ok("…an admin can", m.status === 200 && m.body.class.name === "9-A");

    console.log("starting a new exam");
    const mk = (o) => A.prepare(JSON.stringify({ type: "create_exam", ...o }), teacher);
    r = await mk({ classId: String(nineA._id), prompt: "9-cu sinif riyaziyyat, kəsrlər, 10 test sualı" });
    ok("the card carries the class and the description", r.ok && r.action.params.prompt.startsWith("9-cu sinif") && /«9-A» sinfi üçün yeni imtahan/.test(r.action.title));
    ok("without a topic: refused", !(await mk({ classId: String(nineA._id), prompt: "x" })).ok);
    out = await A.run(r.action, teacher);
    ok("confirming creates nothing, it opens the composer", out.ok && out.link === `/class/${nineA._id}/new-exam` && (await Exam.countDocuments({ owner: teacher._id })) === 2);
    ok("an action it does not know is refused", !(await A.prepare('{"type":"delete_exam","examId":"x"}', teacher)).ok);
    ok("a marker that is not JSON is refused", !(await A.prepare("{oops", teacher)).ok);

    console.log("the card's «Təsdiq et» / «Ləğv et»");
    const { decideAction } = require("../controllers/chatController");
    const call = (msgId, user, decision) =>
      new Promise((resolve) => {
        const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
        decideAction({ params: { id: String(msgId) }, body: { decision }, user }, res, (err) => resolve({ status: err?.statusCode || err?.status || 500, err }));
      });
    r = await upd({ durationMinutes: 30 });
    const card = await Message.create({ conversation: oid(), from: oid(), to: teacher._id, text: "Hazırladım.", ai: true, action: { ...r.action, status: "pending" } });
    let d = await call(card._id, other, "confirm");
    ok("only the teacher it was written to can decide", d.status === 404);
    d = await call(card._id, teacher, "confirm");
    now = await Exam.findById(kesr._id).lean();
    ok("confirm runs it, the card keeps what changed", d.body.action.status === "done" && now.duration === 1800 && d.body.action.result === "Edildi." && d.body.action.lines.includes("Müddət: 60 dəq → 30 dəq"), JSON.stringify(d.body));
    d = await call(card._id, teacher, "confirm");
    ok("a second tap does not run it twice", d.body.action.status === "done" && republished === 2, `${republished}`);
    r = await upd({ durationMinutes: 90 });
    const card2 = await Message.create({ conversation: oid(), from: oid(), to: teacher._id, text: "Hazırladım.", ai: true, action: { ...r.action, status: "pending" } });
    d = await call(card2._id, teacher, "cancel");
    now = await Exam.findById(kesr._id).lean();
    ok("cancel drops it", d.body.action.status === "cancelled" && now.duration === 1800);
    d = await call(card2._id, teacher, "confirm");
    ok("…and a cancelled card cannot be confirmed later", d.body.action.status === "cancelled" && (await Exam.findById(kesr._id).lean()).duration === 1800);
    d = await call(card2._id, teacher, "maybe");
    ok("anything but confirm/cancel is refused", d.status === 400);

    console.log("wired in");
    const asst = require("../services/chatAssistant");
    ok("the app's chat is given the account and the rules; WhatsApp is not", /!whatsapp && account \? `\\n\\n\$\{ACTIONS_NOTE\}\\n\\n\$\{account\}`/.test(read("services/chatAssistant.js")));
    ok("WhatsApp never shows a marker", !asst.forWhatsApp('Bax.\n[[action:{"type":"move_exam"}]]').includes("[[action"));
    ok("the rules say nothing changes before «Təsdiq et»", /«Təsdiq et» basmayınca HEÇ NƏ dəyişmir/.test(A.ACTIONS_NOTE) && /"dəyişdim", "etdim", "köçürdüm" YAZMA/.test(A.ACTIONS_NOTE));
    ok("the card's route is registered for the signed-in teacher", /router\.post\("\/messages\/:id\/action", protect, decideAction\)/.test(read("routes/chatRoute.js")));
    ok("a card that cannot be made gets the reply written again, knowing why (not a «hazırladım» with a refusal tacked on)",
      /KART HAZIRLANMADI/.test(read("controllers/chatController.js")) && /note: why/.test(read("controllers/chatController.js")) && /note = ""/.test(read("services/chatAssistant.js")));
    ok("the move's route needs exam:manage:own", /router\.patch\("\/exam\/:examId\/class", protect, requireCapability\("exam:manage:own"\), moveExamToClass\)/.test(read("routes/quizRoute.js")));
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
