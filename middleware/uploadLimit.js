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
const quotaFor = (user) => {
  if (Number(user?.storageQuotaBytes) > 0) return Number(user.storageQuotaBytes);
  /*
   * The EFFECTIVE plan, so a lapsed subscription loses its allowance the way it
   * loses every other limit. Reading the stored plan meant a Premium that
   * expired last month kept its 15GB indefinitely — the one limit in the app
   * that a payment stopping did not touch.
   */
  const mb = limitsFor(effectivePlan(user)).storageMb;
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_QUOTA;
};

// Bytes this user already has stored — study materials AND uploaded videos both
// live on the same disk, so they share one quota.
async function usedBytes(userId) {
  const [mat, vid] = await Promise.all([
    Material.aggregate([
      { $match: { owner: userId } },
      { $group: { _id: null, bytes: { $sum: { $ifNull: ["$sizeBytes", 0] } } } },
    ]),
    Video.aggregate([
      { $match: { owner: userId, source: "file" } },
      { $group: { _id: null, bytes: { $sum: { $ifNull: ["$sizeBytes", 0] } } } },
    ]),
  ]);
  return (mat[0]?.bytes || 0) + (vid[0]?.bytes || 0);
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

  // Never below the truth. `$lt` leaves a larger counter alone, which is what
  // protects an in-flight reservation from being erased by a concurrent repair.
  await User.updateOne(
    { _id: user._id, $or: [{ storageBytes: { $lt: used } }, { storageBytes: { $exists: false } }] },
    { $set: { storageBytes: used } }
  );

  const won = await User.findOneAndUpdate(
    { _id: user._id, storageBytes: { $lte: limit - bytes } },
    { $inc: { storageBytes: bytes } },
    { new: true, projection: { storageBytes: 1 } }
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
    used: won.storageBytes,
    limit,
    incoming: bytes,
    // Called when the upload does NOT become a row, so the claim does not
    // outlive the file it was made for.
    release: async () => {
      await User.updateOne({ _id: user._id }, { $inc: { storageBytes: -bytes } }).catch(() => {});
    },
  };
}

/*
 * After a deletion the counter is recomputed rather than decremented: a
 * decrement can go negative when it races a repair, and a negative counter is
 * the one drift direction that would let an account over its limit.
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
  if (used + declared <= limit) return next();
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
   * Give the bytes back unless the upload actually became a row.
   *
   * A handler can refuse after this point for a dozen reasons — a bad magic
   * byte, a missing title, a failed conversion, a thrown error — and releasing
   * at each of those sites means the one that gets forgotten silently charges a
   * teacher for a file that never existed. Hooking the response instead covers
   * every exit, including the ones nobody thought of, and the handler opts IN by
   * setting storageCommitted once the material is saved.
   */
  res.on("finish", () => {
    if (!req.storageCommitted) claim.release().catch(() => {});
  });
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
  human,
  DEFAULT_QUOTA,
};
