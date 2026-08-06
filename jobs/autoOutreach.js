const User = require("../models/userModel");
const AppSetting = require("../models/appSettingModel");
const { stuckStateForOwners } = require("../helper/stuckTeachers");
const wa = require("../helper/whatsapp");

// ─────────────────────────────────────────────────────────────────────────────
// Auto-outreach watcher.
//
// Watches NEW teacher registrations. When a teacher has been registered for
// longer than the grace window (default 10 min) and still hasn't finished
// setting up — empty exam, empty class, or nothing at all — they get ONE warm
// WhatsApp from the admin's LINKED number (whatsapp-web.js), tailored to how far
// they got. Each teacher is messaged AT MOST ONCE (terminal status recorded on
// the user), and if there's no linked/ready admin WhatsApp the sweep does
// nothing (never falls back to wa.me).
//
// Toggle is admin-controlled and persisted (AppSetting). Enabling it records a
// "watch from" timestamp so it only ever targets registrations AFTER it was
// switched on — it does NOT blast the historical backlog (that's what the manual
// per-row WhatsApp button is for).
// ─────────────────────────────────────────────────────────────────────────────

const ENABLED_KEY = "autoOutreachEnabled";
const SINCE_KEY = "autoOutreachSince";

const WATCH_MINUTES = Number(process.env.OUTREACH_WATCH_MINUTES) || 10;
const MAX_PER_SWEEP = Number(process.env.OUTREACH_MAX_PER_SWEEP) || 5;
const SEND_GAP_MS = Number(process.env.OUTREACH_SEND_GAP_MS) || 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  const [enabled, since] = await Promise.all([
    AppSetting.findOne({ key: ENABLED_KEY }).lean(),
    AppSetting.findOne({ key: SINCE_KEY }).lean(),
  ]);
  return {
    enabled: !!(enabled && enabled.value),
    since: since && since.value ? new Date(since.value) : null,
  };
}

// Flip the watcher on/off. Turning it ON (re)stamps the "watch from" time to
// now, so it starts watching new registrations forward, not the backlog.
async function setEnabled(on, now = new Date()) {
  await AppSetting.updateOne(
    { key: ENABLED_KEY },
    { $set: { value: !!on } },
    { upsert: true }
  );
  if (on) {
    await AppSetting.updateOne(
      { key: SINCE_KEY },
      { $set: { value: now } },
      { upsert: true }
    );
  }
  return getSettings();
}

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

// The tailored outreach scripts — first name only, warm, asks what went wrong
// and offers to help. Mirror of the frontend manual scripts.
function outreachMessage(u, stuck) {
  const fn = firstName(u.name);
  const n = fn ? ` ${fn}` : "";
  if (stuck.hasEmptyExam)
    return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, imtahan yaratmağa başlamısınız, amma sual əlavə etməmisiniz. Nə oldu? Hansı hissə çətin gəldi, nədə ilişdiniz? İstəsəniz, birlikdə edə bilərik — kömək etməkdən məmnun olaram 🌷`;
  if (stuck.hasEmptyClass)
    return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, sinif yaratmısınız, amma hələ imtahan əlavə etməmisiniz. Nə oldu? Hansı hissə çətin gəldi, nədə ilişdiniz? İstəsəniz, birlikdə ilk imtahanınızı yarada bilərik — kömək etməkdən məmnun olaram 🌷`;
  return `Salam${n} 🙂 Examopia komandasından yazıram. Gördüm ki, qeydiyyatdan keçmisiniz, amma hələ başlamamısınız. Nə oldu? Hansı hissə çətin gəldi, nə sizi dayandırdı? İstəsəniz, birlikdə ilk imtahanınızı yarada bilərik — kömək etməkdən məmnun olaram 🌷`;
}

// One sweep. Idempotent, bounded, and safe to call on an interval.
async function runOutreachSweep(now = new Date()) {
  const { enabled, since } = await getSettings();
  if (!enabled) return { skipped: "disabled" };

  // Need a linked, ready admin WhatsApp session — else STOP (don't send).
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const senderId = wa.firstReadyOwner(admins.map((a) => a._id));
  if (!senderId) return { skipped: "no_linked_whatsapp" };

  // Candidates: teachers registered ≥ grace ago (and after the watcher was
  // switched on), with a phone, never contacted. Over-fetch because many will
  // have finished setup and get filtered out below.
  const cutoff = new Date(now.getTime() - WATCH_MINUTES * 60 * 1000);
  const q = {
    role: "teacher",
    createdAt: { $lte: cutoff },
    phone: { $nin: [null, ""] },
    outreachStatus: { $in: [null] }, // matches null OR missing
  };
  if (since) q.createdAt.$gte = since;

  const candidates = await User.find(q)
    .select("_id name phone createdAt")
    .sort({ createdAt: 1 })
    .limit(MAX_PER_SWEEP * 5)
    .lean();
  if (!candidates.length) return { checked: 0, sent: 0, skipped: 0, failed: 0 };

  const stuckMap = await stuckStateForOwners(candidates.map((c) => c._id));
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const u of candidates) {
    if (sent + skipped + failed >= MAX_PER_SWEEP) break;
    const stuck = stuckMap.get(String(u._id));
    if (!stuck || !stuck.isStuck) continue; // finished setup → leave alone

    let status = "failed";
    try {
      status = await wa.sendOutreachFor(senderId, u.phone, outreachMessage(u, stuck));
    } catch {
      status = "failed";
    }
    if (status === "not_ready") break; // session dropped mid-sweep → retry next tick, don't burn users

    // Record a TERMINAL status so this teacher is never messaged again.
    const persist = status === "sent" ? "sent" : status === "no_whatsapp" ? "skipped" : "failed";
    await User.updateOne(
      { _id: u._id, outreachStatus: { $in: [null] } },
      { $set: { outreachStatus: persist, outreachAt: new Date(), outreachReason: status } }
    );
    if (persist === "sent") sent += 1;
    else if (persist === "skipped") skipped += 1;
    else failed += 1;

    // Space real sends out a little so a burst doesn't look like a bot.
    if (persist === "sent" && sent + skipped + failed < MAX_PER_SWEEP) await sleep(SEND_GAP_MS);
  }

  if (sent || failed) console.log(`[OUTREACH] sweep: sent=${sent} skipped=${skipped} failed=${failed} of ${candidates.length}`);
  return { checked: candidates.length, sent, skipped, failed };
}

module.exports = {
  runOutreachSweep,
  getSettings,
  setEnabled,
  outreachMessage,
  firstName,
  WATCH_MINUTES,
};
