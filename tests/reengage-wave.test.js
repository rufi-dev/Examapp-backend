/* eslint-env node */
/*
 * The second WhatsApp wave: a teacher on no paid plan who has not opened the
 * site for a week gets ONE reminder, and never a second one, however many more
 * quiet weeks follow.
 *
 * Runs the real sweep against an in-memory database with the WhatsApp sender
 * replaced by a recorder, so what is asserted is who would actually be messaged.
 */
process.env.NODE_ENV = "test";

const path = require("path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra);
  }
};

// The sender, recorded instead of sent. Installed before the job is loaded.
const sent = [];
const fakeWa = {
  accountKey: (id, slot) => (slot === 2 ? `${id}__wa2` : String(id)),
  readyOwners: (keys) => keys.slice(0, 1),
  nextReadyOwner: (keys) => keys[0],
  firstReadyOwner: (ids) => (ids[0] ? String(ids[0]) : null),
  sendOutreachFor: async (sender, phone, text) => {
    sent.push({ phone, text });
    return phone.endsWith("0000") ? "no_whatsapp" : "sent";
  },
};
const waPath = require.resolve(path.join(__dirname, "..", "helper", "whatsapp"));
require.cache[waPath] = { id: waPath, filename: waPath, loaded: true, exports: fakeWa };
// The mailer, recorded the same way.
const mails = [];
const mailPath = require.resolve(path.join(__dirname, "..", "utils", "sendEmail"));
require.cache[mailPath] = {
  id: mailPath,
  filename: mailPath,
  loaded: true,
  exports: { sendNotification: async (m) => (mails.push(m), { messageId: "test" }) },
};

const User = require("../models/userModel");
const AppSetting = require("../models/appSettingModel");
const job = require("../jobs/autoOutreach");

const DAY = 24 * 60 * 60 * 1000;
// 12:00 in Baku (UTC+4): inside sending hours.
const NOW = new Date("2026-10-09T08:00:00Z");
const ago = (days) => new Date(NOW.getTime() - days * DAY);

let seq = 0;
async function teacher(fields) {
  seq += 1;
  const u = await User.create({
    name: `Aysel${seq} Məmmədova`,
    email: `rw${seq}@example.com`,
    password: "x".repeat(20),
    role: "teacher",
    phone: `99450123${String(4500 + seq).padStart(4, "0")}`,
  });
  // Timestamps are set directly: `createdAt` is managed by mongoose on create.
  await User.collection.updateOne({ _id: u._id }, { $set: { createdAt: ago(30), ...fields } });
  return u;
}

const queued = async () => (await User.find(job.reengageQuery(NOW)).select("_id").lean()).map((u) => String(u._id));

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await User.create({ name: "Admin", email: "admin@example.com", password: "x".repeat(20), role: "admin" });

  console.log("\n1. Who the second wave is for");
  const quiet = await teacher({ lastActiveAt: ago(10) });
  const neverBack = await teacher({ lastActiveAt: null });
  const active = await teacher({ lastActiveAt: ago(2) });
  const paid = await teacher({ lastActiveAt: ago(10), plan: "pro" });
  const fresh = await teacher({ lastActiveAt: null, createdAt: ago(3) });
  const justWaved = await teacher({ lastActiveAt: ago(10), outreachStatus: "sent", outreachAt: ago(3) });
  const wavedLongAgo = await teacher({ lastActiveAt: ago(40), outreachStatus: "sent", outreachAt: ago(20) });
  const deleted = await teacher({ lastActiveAt: ago(10), deletedAt: ago(1) });
  const noPhone = await teacher({ lastActiveAt: ago(10), phone: "+994" });
  const q = await queued();
  const has = (u) => q.includes(String(u._id));
  ok("free + quiet for 10 days → queued", has(quiet));
  ok("never came back after registering a month ago → queued", has(neverBack));
  ok("first-wave message 20 days ago → queued", has(wavedLongAgo));
  ok("opened the site 2 days ago → not", !has(active));
  ok("on a paid plan → not", !has(paid));
  ok("registered 3 days ago → not yet", !has(fresh));
  ok("first-wave message 3 days ago → not yet", !has(justWaved));
  ok("deleted → not", !has(deleted));
  ok("no number given → not", !has(noPhone));

  console.log("\n2. The sweep sends one at a time, newest registration first");
  await AppSetting.updateOne({ key: "reengageEnabled" }, { $set: { value: true } }, { upsert: true });
  ok("off by default for the first wave here", !(await job.getSettings()).enabled);
  let t = NOW.getTime();
  const sweep = async () => {
    const r = await job.runOutreachSweep(new Date(t));
    t += 31 * 60 * 1000; // past the gap
    return r;
  };
  const r1 = await sweep();
  ok("one message per slot", r1.sent === 1 && sent.length === 1, JSON.stringify(r1));
  ok("greets by first name", sent[0].text.startsWith("Salam Aysel"), sent[0].text.slice(0, 30));
  ok("...as the teacher", /^Salam Aysel\d+ müəllim 😊/.test(sent[0].text));
  ok("carries the link", sent[0].text.includes("https://examopia.com/login"));
  const r2 = await sweep();
  const r3 = await sweep();
  ok("the rest go on later sweeps", r2.sent === 1 && r3.sent === 1 && sent.length === 3);
  const r4 = await sweep();
  ok("then the queue is empty", r4.drained === true && sent.length === 3, JSON.stringify(r4));

  console.log("\n3. Only ONCE per teacher");
  const marked = await User.findById(quiet._id).lean();
  ok("the teacher is marked sent", marked.reengageStatus === "sent" && !!marked.reengageAt);
  // Comes back, goes quiet again for another two weeks.
  await User.collection.updateOne({ _id: quiet._id }, { $set: { lastActiveAt: new Date(t - 14 * DAY) } });
  const again = await sweep();
  ok("another quiet week sends nothing again", !again.sent && sent.length === 3, JSON.stringify(again));
  ok("...and they are not back in the queue", !(await User.find(job.reengageQuery(new Date(t))).lean()).some((u) => String(u._id) === String(quiet._id)));

  console.log("\n4. A number that is not on WhatsApp is closed, not retried");
  const dead = await teacher({ lastActiveAt: ago(10), phone: "994501230000" });
  await sweep();
  const deadNow = await User.findById(dead._id).lean();
  ok("marked skipped", deadNow.reengageStatus === "skipped");
  ok("and out of the queue for good", !(await User.find(job.reengageQuery(new Date(t))).lean()).some((u) => String(u._id) === String(dead._id)));

  console.log("\n5. The second wave obeys the shared limits");
  await AppSetting.updateOne({ key: "reengageEnabled" }, { $set: { value: false } });
  const off = await job.runOutreachSweep(new Date(t + 60 * 60 * 1000));
  ok("switched off → nothing", off.skipped === "disabled", JSON.stringify(off));
  await AppSetting.updateOne({ key: "reengageEnabled" }, { $set: { value: true } });
  await teacher({ lastActiveAt: ago(10) });
  const night = new Date("2026-10-09T19:00:00Z"); // 23:00 in Baku
  const r5 = await job.runOutreachSweep(night);
  ok("nothing at night", r5.skipped === "outside_hours", JSON.stringify(r5));

  console.log("\n6. The email follows the WhatsApp step, once");
  const { unsubscribePath, checkUnsubscribeToken, unsubscribeToken } = require("../helper/unsubscribe");
  ok("no email while its switch is off", mails.length === 0, mails.length);
  await AppSetting.updateOne({ key: "reengageEmailEnabled" }, { $set: { value: true } }, { upsert: true });
  const optedOut = await teacher({ lastActiveAt: ago(10), reengageStatus: "sent", reengageAt: ago(1), emailOptOut: true });
  const mailT = t + 2 * 60 * 60 * 1000; // still inside hours
  await job.runOutreachSweep(new Date(mailT));
  const to = (u) => mails.filter((m) => m.to === u.email);
  ok("the teacher who got the WhatsApp gets the email", to(quiet).length === 1);
  ok("...and so does the one with no WhatsApp", to(dead).length === 1);
  ok("not before the WhatsApp step ran for them", to(active).length === 0 && to(fresh).length === 0);
  ok("never to someone who unsubscribed", to(optedOut).length === 0);
  const m = to(quiet)[0] || {};
  ok("the reengage template", m.kind === "reengage");
  ok("subject greets by first name", /^Aysel\d+ müəllim, qeydiyyatdan keçdiniz/.test(m.subject || ""), m.subject);
  ok("the footer link is this teacher's unsubscribe page", m.link === unsubscribePath(quiet._id));
  await job.runOutreachSweep(new Date(mailT + 10 * 60 * 1000));
  await job.runOutreachSweep(new Date(mailT + 20 * 60 * 1000));
  ok("never a second email", to(quiet).length === 1 && to(dead).length === 1);
  ok("marked sent", (await User.findById(quiet._id).lean()).reengageEmailStatus === "sent");

  console.log("\n7. The unsubscribe link cannot be forged");
  ok("its own token passes", checkUnsubscribeToken(String(quiet._id), unsubscribeToken(String(quiet._id))));
  ok("another teacher's token fails", !checkUnsubscribeToken(String(quiet._id), unsubscribeToken(String(dead._id))));
  ok("a made-up one fails", !checkUnsubscribeToken(String(quiet._id), "0".repeat(32)));

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
