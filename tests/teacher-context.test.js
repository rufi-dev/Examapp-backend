/* eslint-env node */
/*
 * What the support AI is told about the teacher it is talking to (owner,
 * 2026-10-13: "the AI should identify which stage the teacher is in"): plan,
 * counts and a stage, A (nothing built) / B (stalled) / E (free, and whether a
 * limit is near) / F (paying). Counts only. Stubbed database calls.
 */
process.env.NODE_ENV = "test";

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

const User = require("../models/userModel");
const Exam = require("../models/examModel");
const Result = require("../models/resultModel");
const PL = require("../helper/planLimits");

let user;
let usage;
let examIds;
let results;
User.findById = () => ({ select: () => ({ lean: async () => user }) });
Exam.find = () => ({ distinct: async () => examIds });
Result.countDocuments = async () => results;
PL.usageFor = async () => usage;
PL.effectivePlan = (u) => u.plan;

const { teacherContext } = require("../helper/teacherContext");
const day = 86400000;
const freeUsage = (o = {}) => ({
  expired: false,
  classes: { used: 0, limit: 1 },
  students: { used: 0, limit: 10 },
  examCreates: { left: 3, limit: 3 },
  ...o,
});

(async () => {
  console.log("the stage");
  user = { _id: "u", role: "teacher", name: "Nərmin Əliyeva", plan: "free", aiCredits: 60, createdAt: new Date(Date.now() - 3 * day), lastActiveAt: new Date(Date.now() - 3 * day) };
  usage = freeUsage();
  examIds = [];
  results = 0;
  let line = await teacherContext("u");
  ok("nothing built yet: A", /MƏRHƏLƏ: A/.test(line), line);
  ok("…with the plan, the counts and the days, and the first name only", /adı Nərmin;/.test(line) && !/Əliyeva/.test(line) && /Pulsuz paket/.test(line) && /sinif 0 \(limit 1\)/.test(line) && /qeydiyyat 3 gün əvvəl/.test(line), line);
  ok("…and told not to recite the numbers", /rəqəmləri müəllimə sadalama/.test(line));

  usage = freeUsage({ classes: { used: 1, limit: 1 } });
  line = await teacherContext("u");
  ok("a class but no exam: B (stalled)", /MƏRHƏLƏ: B/.test(line), line);
  usage = freeUsage({ classes: { used: 1, limit: 1 }, students: { used: 4, limit: 10 } });
  examIds = ["e1"];
  results = 0;
  line = await teacherContext("u");
  ok("exams no student has taken: B", /MƏRHƏLƏ: B/.test(line), line);

  results = 12;
  line = await teacherContext("u");
  ok("working on the free plan: E", /MƏRHƏLƏ: E \(pulsuz paketdə işləyir:/.test(line), line);
  usage = freeUsage({ classes: { used: 1, limit: 1 }, students: { used: 9, limit: 10 }, examCreates: { left: 0, limit: 3 } });
  user.aiCredits = 4;
  line = await teacherContext("u");
  ok("…near its limits: says which", /limitə yaxındır: imtahan yaratmaq haqqı qalıb: 0\/3, şagird 9\/10, AI krediti 4;/.test(line), line);

  user = { ...user, plan: "premium", aiCredits: 1500 };
  usage = { expired: false, classes: { used: 6, limit: null }, students: { used: 74, limit: null }, examCreates: { left: null, limit: null } };
  line = await teacherContext("u");
  ok("paying: F, and no limits shown", /MƏRHƏLƏ: F/.test(line) && /sinif 6;/.test(line) && !/limit/.test(line.split("GÜMAN")[0].replace("limitə", "")), line);

  console.log("\nnever in the way");
  user = { _id: "s", role: "student" };
  ok("not a teacher: nothing", (await teacherContext("s")) === "");
  user = null;
  ok("not found: nothing", (await teacherContext("x")) === "");
  ok("no id: nothing", (await teacherContext(null)) === "");
  user = { _id: "u", role: "teacher", plan: "free" };
  PL.usageFor = async () => {
    throw new Error("db down");
  };
  ok("anything failing: nothing (the reply never waits on it)", (await teacherContext("u")) === "");

  console.log("\nwired in");
  const fs = require("fs");
  const path = require("path");
  const chat = fs.readFileSync(path.join(__dirname, "..", "controllers", "chatController.js"), "utf8");
  const wa = fs.readFileSync(path.join(__dirname, "..", "helper", "waAutoReply.js"), "utf8");
  const asst = fs.readFileSync(path.join(__dirname, "..", "services", "chatAssistant.js"), "utf8");
  ok("the site's chat passes the teacher's line", /teacherContext\(teacherId\)/.test(chat) && /generateSupportReply\(recent, adminId, \{ profile, account \}\)/.test(chat));
  ok("WhatsApp passes it too (not for the owner's own test number)", /teacher\.tester \? "" : await require\("\.\/teacherContext"\)\.teacherContext\(teacher\._id\)/.test(wa) && /context: ours\?\.body \|\| "", profile \}/.test(wa));
  ok("the assistant puts it in the prompt", /const about = `\$\{profile \? `\\n\\n\$\{profile\}` : ""\}/.test(asst));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
