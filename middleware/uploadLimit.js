const asyncHandler = require("express-async-handler");
const Material = require("../models/materialModel");
const Video = require("../models/videoModel");
const User = require("../models/userModel");
const { limitsFor, normalizePlan } = require("../config/plans");

/*
 * Required lazily: planLimits requires this module for storageStatus, so a
 * top-level require here would be a cycle and one of the two would get a
 * half-built exports object.
 */
const effectivePlan = (user) => require("../helper/planLimits").effectivePlan(user);

// ---------------------------------------------------------------------------
// Upload abuse protection for study materials.
//
// Anyone can self-assign the teacher role at registration, and a teacher may
// upload 200MB files that can spawn a 120-second LibreOffice process. Without a
// guard one account can fill the disk or peg the CPU. Three layers:
//   1) uploadRateLimit  — uploads per hour, per user (in-memory, one container).
//   2) storageQuota     — total bytes already stored, per user, from the DB.
//   3) the conversion queue in utils/convertQueue.js — one at a time.
//
// Admins are exempt from all three, and a per-teacher override raises the quota
// for the accounts that legitimately need it.
// ---------------------------------------------------------------------------

const WINDOW_MS = Number(process.env.UPLOAD_RATE_WINDOW_MS || 60 * 60 * 1000); // 1h
const MAX_PER_WINDOW = Number(process.env.UPLOAD_RATE_MAX || 20);
/*
 * The fallback when an account has no plan the config recognises. Every real
 * tier now carries its own storageMb (see config/plans.js) — this is only the
 * floor under a corrupted or unknown plan value, and it is deliberately the
 * smallest one: an unreadable plan must not resolve to the most generous tier.
 */
const DEFAULT_QUOTA = Number(process.env.UPLOAD_QUOTA_BYTES || 50 * 1024 * 1024);
// Field names, boundaries and the form's own text. Generous, because this gate
// only exists to spare the disk — being wrong here costs one write, and being
// wrong the other way refuses a file that fits.
const MULTIPART_SLACK = 64 * 1024;

const hits = new Map(); // userId -> { count, resetAt }

const mb = (n) => Math.round(n / (1024 * 1024));
const gb = (n) => (n / (1024 * 1024 * 1024)).toFixed(1);

// Counts the ATTEMPT, not the success: a rejected 200MB upload has already cost
// the bandwidth and the disk write, so retries have to be bounded too.
function uploadRateLimit(req, res, next) {
  if (req.user?.role === "admin" || MAX_PER_WINDOW <= 0) return next();
  const id = String(req.user?._id || req.ip || "anon");
  const now = Date.now();

  if (hits.size > 5000) {
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }

  let e = hits.get(id);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + WINDOW_MS };
    hits.set(id, e);
  }
  e.count += 1;
  if (e.count > MAX_PER_WINDOW) {
    const mins = Math.ceil((e.resetAt - now) / 60000);
    res.set("Retry-After", String(Math.ceil((e.resetAt - now) / 1000)));
    res.status(429);
    throw new Error(
      `Saatda ${MAX_PER_WINDOW} fayldan çox yükləmək olmaz. ${mins} dəqiqədən sonra yenidən cəhd edin.`
    );
  }
  next();
}

/*
 * What this account may hold, in bytes.
 *
 * An explicit per-teacher override wins — it is the escape hatch for the handful
 * of accounts that genuinely need more, and it must not be undone by a plan
 * change. Otherwise the tier decides, which is the point of this change: a count
 * limit never bounded disk, and disk is what costs us money.
 */
/*
 * Extra storage bought separately, if it is still paid for.
 *
 * A null expiry is an open-ended admin grant. A past expiry is worth nothing:
 * the add-on is rent, not a purchase, and the month it covers has ended.
 */
const addonBytes = (user) => {
  const gb = Number(user?.storageAddonGb) || 0;
  if (gb <= 0) return 0;
  const until = user?.storageAddonExpiresAt;
  if (until && new Date(until).getTime() < Date.now()) return 0;
  return gb * 1024 * 1024 * 1024;
};

const quotaFor = (user) => {
  // The permanent per-teacher override is absolute: it exists for the handful of
  // accounts an admin has decided are a special case, and stacking a plan on top
  // of it would make that decision mean something different every month.
  if (Number(user?.storageQuotaBytes) > 0) return Number(user.storageQuotaBytes);
  /*
   * The EFFECTIVE plan, so a lapsed subscription loses its allowance the way it
   * loses every other limit. Reading the stored plan meant a Premium that
   * expired last month kept its 15GB indefinitely — the one limit in the app
   * that a payment stopping did not touch.
   */
  const mb = limitsFor(effectivePlan(user)).storageMb;
  const base = Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_QUOTA;
  // Added to the plan rather than replacing it: someone who buys 10GB on Pro
  // expects 10GB MORE, and would be furious to find they had bought a downgrade.
  return base + addonBytes(user);
};

/*
 * Everything this teacher has put on our disk.
 *
 * It used to be library materials and uploaded videos only, which made the meter
 * a lie by omission: a teacher could fill the server with whiteboards, exam PDFs
 * and curriculum scans and still be told they had used nothing. Every store a
 * TEACHER uploads into is counted now, because every one of them is disk we pay
 * for every month.
 *
 * Student submissions are deliberately NOT counted. A teacher cannot control how
 * much their class uploads, and charging them for it would mean a popular
 * teacher running out of room for work that is not theirs.
 *
 * Seven scoped counts rather than one, run together. Each is a single-owner
 * query against an indexed field, which is why this is cheap enough to sit in
 * front of every upload.
 */
async function usedBytes(userId) {
  const sumOf = (model, match, field) =>
    model.aggregate([
      { $match: match },
      { $group: { _id: null, bytes: { $sum: { $ifNull: [`$${field}`, 0] } } } },
    ]).then((r) => r[0]?.bytes || 0).catch(() => 0);

  const Assignment = require("../models/assignmentModel");
  const Board = require("../models/boardModel");
  const LessonDoc = require("../models/lessonDocModel");
  const Pdf = require("../models/pdfModel");
  const CurriculumSource = require("../models/curriculumSourceModel");
  const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");

  /*
   * A curriculum version does not carry its owner - it reaches one through the
   * source it belongs to. Two indexed steps beat a $lookup: the sources are
   * indexed by owner, and a teacher has a handful of them.
   */
  const curriculumBytes = async () => {
    try {
      const ids = await CurriculumSource.find({ owner: userId }).distinct("_id");
      if (!ids.length) return 0;
      return await sumOf(CurriculumSourceVersion, { source: { $in: ids } }, "bytes");
    } catch {
      return 0;
    }
  };

  const assignmentBytes = async () => {
    try {
      const r = await Assignment.aggregate([
        { $match: { owner: userId } },
        { $unwind: { path: "$attachments", preserveNullAndEmptyArrays: false } },
        { $group: { _id: null, bytes: { $sum: { $ifNull: ["$attachments.sizeBytes", 0] } } } },
      ]);
      return r[0]?.bytes || 0;
    } catch {
      return 0;
    }
  };

  // Studio attachments hang off the document in an array.
  const lessonDocBytes = async () => {
    try {
      const r = await LessonDoc.aggregate([
        { $match: { owner: userId } },
        { $unwind: { path: "$files", preserveNullAndEmptyArrays: false } },
        { $group: { _id: null, bytes: { $sum: { $ifNull: ["$files.bytes", 0] } } } },
      ]);
      return r[0]?.bytes || 0;
    } catch {
      return 0;
    }
  };

  const parts = await Promise.all([
    sumOf(Material, { owner: userId }, "sizeBytes"),
    sumOf(Video, { owner: userId, source: "file" }, "sizeBytes"),
    // The worksheets a TEACHER hands out with a task - an ARRAY on the task, not
    // a field, which is why summing it needs an unwind. What students send back
    // lives in submissions and is not counted at all.
    assignmentBytes(),
    sumOf(Board, { owner: userId }, "sizeBytes"),
    sumOf(Pdf, { owner: userId }, "size"),
    lessonDocBytes(),
    curriculumBytes(),
  ]);
  return parts.reduce((n, b) => n + b, 0);
}

// Sizes the way a teacher reads them: MB until it is silly, then GB.
const human = (b) => {
  const n = Number(b) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
};

/*
 * What this account holds and what it may hold — the number the teacher sees.
 *
 * `used` is the SUM OF THEIR ROWS, not the counter, because the counter is a
 * gate mechanism and may sit above the truth while an upload is in flight or
 * after a crash. Showing someone a fuller bar than their files justify would be
 * a lie they cannot check.
 */
async function storageStatus(user) {
  const limit = quotaFor(user);
  const unlimited = user?.role === "admin";
  const used = await usedBytes(user._id);
  const extra = addonBytes(user);
  return {
    used,
    limit: unlimited ? null : limit,
    unlimited,
    remaining: unlimited ? null : Math.max(0, limit - used),
    percent: unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 10000) / 100),
    full: unlimited ? false : used >= limit,
    // What is in force, not what was bought — a lapsed plan shows as free here
    // because that is the allowance being applied.
    plan: effectivePlan(user),
    /*
     * The add-on is reported separately so the teacher can see WHICH part of
     * their allowance is rented and when it runs out. A single number would let
     * the allowance shrink one morning with no warning and no explanation.
     */
    addon: extra > 0
      ? {
          gb: Number(user?.storageAddonGb) || 0,
          label: human(extra),
          expiresAt: user?.storageAddonExpiresAt || null,
          daysLeft: user?.storageAddonExpiresAt
            ? Math.max(0, Math.ceil((new Date(user.storageAddonExpiresAt).getTime() - Date.now()) / 86400000))
            : null,
        }
      : null,
    usedLabel: human(used),
    limitLabel: unlimited ? "limitsiz" : human(limit),
    // Formatted here rather than in the browser so the page and the refusal
    // message quote the same number in the same units.
    remainingLabel: unlimited ? "limitsiz" : human(Math.max(0, limit - used)),
  };
}

/*
 * Claim room for a file, atomically.
 *
 * Summing, deciding and then writing is a read-then-write: two uploads sent at
 * the same moment both read the same "before", both fit, and the account ends up
 * over its limit. The conditional $inc below is the only thing Mongo offers that
 * two requests cannot both win — whichever arrives second sees the first one's
 * bytes already counted and is refused.
 *
 * The counter is repaired UPWARD from the row sum first, and never downward, so
 * a reservation left behind by a crash makes the gate stricter rather than
 * looser. Stricter is recoverable — the teacher deletes a file, or an admin
 * reconciles. Looser is a bill.
 */
async function reserveStorage(user, incoming) {
  if (user?.role === "admin") return { ok: true, admin: true, release: async () => {} };
  const limit = quotaFor(user);
  const bytes = Math.max(0, Number(incoming) || 0);
  const used = await usedBytes(user._id);

  /*
   * The committed counter is simply set to the truth.
   *
   * It used to be raised only, never lowered, because a single counter also held
   * the in-flight claims and lowering it would have erased them. They live in
   * storageReserved now, so there is nothing here to protect - and raising only
   * had become a real fault: deleting a board or an exam PDF left the counter
   * high for ever, and the teacher could not reclaim the space they had freed.
   */
  await User.updateOne({ _id: user._id }, { $set: { storageBytes: used } });

  /*
   * Committed + already-claimed + this file must fit. `$expr` lets the sum be
   * computed inside the filter, so the decision and the increment are one
   * operation and two simultaneous uploads cannot both pass it.
   */
  const won = await User.findOneAndUpdate(
    {
      _id: user._id,
      $expr: {
        $lte: [
          { $add: [{ $ifNull: ["$storageBytes", 0] }, { $ifNull: ["$storageReserved", 0] }, bytes] },
          limit,
        ],
      },
    },
    { $inc: { storageReserved: bytes } },
    { new: true, projection: { storageBytes: 1, storageReserved: 1 } }
  );
  if (!won) {
    return {
      ok: false,
      used,
      limit,
      incoming: bytes,
      message:
        `Yaddaş limiti dolub. Paketiniz: ${human(limit)}, istifadə olunub: ${human(used)}, ` +
        `bu fayl: ${human(bytes)}. Köhnə faylları silin və ya paketi yüksəldin.`,
      release: async () => {},
    };
  }
  return {
    ok: true,
    used: (won.storageBytes || 0) + (won.storageReserved || 0),
    limit,
    incoming: bytes,
    /*
     * Released when the response ends, whether or not a file came of it.
     *
     * A claim is transient in BOTH outcomes: if the upload failed the bytes are
     * nowhere, and if it succeeded they are in the rows, which is where the next
     * reservation reads them from. There is therefore no "committed" state for a
     * caller to forget to set — and forgetting it was exactly how the video
     * replacement path lost a teacher's quota while storing their file.
     */
    release: async () => {
      await User.updateOne({ _id: user._id }, { $inc: { storageReserved: -bytes } }).catch(() => {});
      // A double release must not leave a negative claim, which would read as
      // free space that does not exist.
      await User.updateOne({ _id: user._id, storageReserved: { $lt: 0 } }, { $set: { storageReserved: 0 } }).catch(() => {});
    },
  };
}

/*
 * After a deletion the COMMITTED counter is recomputed from the rows.
 *
 * Only that field. In-flight claims live in storageReserved and are left alone,
 * so a delete landing in the middle of an upload no longer erases that upload's
 * claim — which was a race that let the account past its limit.
 */
async function recountStorage(userId) {
  const used = await usedBytes(userId);
  await User.updateOne({ _id: userId }, { $set: { storageBytes: used } }).catch(() => {});
  return used;
}

/*
 * The cheap gate, BEFORE multer.
 *
 * multer streams to disk as the bytes arrive, so by the time a handler runs, a
 * 400MB upload has already been written and paid for in bandwidth and IO. The
 * declared length is an upper bound on the file inside the envelope, so judging
 * it here refuses the hopeless cases without touching the disk. It is an
 * optimisation, not the gate — a declared length can be wrong or absent, which
 * is why the exact check still runs afterwards.
 */
const storageGate = asyncHandler(async (req, res, next) => {
  if (req.user?.role === "admin") return next();
  const declared = Number(req.headers["content-length"] || 0);
  if (!declared) return next();
  const limit = quotaFor(req.user);
  const used = await usedBytes(req.user._id);
  /*
   * The declared length is the whole multipart envelope — boundaries, field
   * names, the title, the class list — so it overstates the file by a few
   * hundred bytes. Judged strictly, a file that fits with room to spare could be
   * refused for its own form fields. The slack keeps borderline cases for the
   * exact check downstream, which measures the file itself.
   */
  if (used + declared - MULTIPART_SLACK <= limit) return next();
  res.status(402);
  throw new Error(
    `Yaddaş limiti dolub. Paketiniz: ${human(limit)}, istifadə olunub: ${human(used)}. ` +
      "Köhnə faylları silin və ya paketi yüksəldin."
  );
});

/*
 * The exact gate, after multer, on the real file size.
 *
 * This one RESERVES rather than merely checking, and it fails CLOSED. The old
 * version failed open on a database error, reasoning that a transient blip
 * should not block a real teacher — but a quota that yields under load is not a
 * quota, and if Mongo is unreachable the upload cannot be recorded anyway.
 */
const storageQuota = asyncHandler(async (req, res, next) => {
  if (req.user?.role === "admin") return next();
  const incoming = Number(req.file?.size || 0);
  let claim;
  try {
    claim = await reserveStorage(req.user, incoming);
  } catch (e) {
    console.error("storageQuota reservation failed (refusing):", e?.message);
    req.quotaRejected = { used: 0, limit: quotaFor(req.user), incoming, message: "Yaddaş yoxlanıla bilmədi. Bir az sonra yenidən cəhd edin." };
    return next();
  }
  if (!claim.ok) {
    req.quotaRejected = { used: claim.used, limit: claim.limit, incoming, message: claim.message };
    return next();
  }
  req.storageClaim = claim;
  /*
   * The claim ends with the response, whatever the response was.
   *
   * A handler can finish a dozen ways — saved, refused for a bad magic byte,
   * refused for a missing title, thrown — and a claim that each of those has to
   * remember to settle is a claim that one of them will get wrong. It did: the
   * video replacement path stored the file and never marked it, so a teacher's
   * quota was handed back under a file that existed.
   *
   * There is nothing to remember now. A successful upload's bytes are in the
   * rows by the time this runs, and the rows are what the next reservation reads.
   */
  res.on("finish", () => { claim.release().catch(() => {}); });
  next();
});

module.exports = {
  uploadRateLimit,
  storageGate,
  storageQuota,
  storageStatus,
  reserveStorage,
  recountStorage,
  usedBytes,
  quotaFor,
  addonBytes,
  human,
  DEFAULT_QUOTA,
};
