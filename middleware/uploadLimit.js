const asyncHandler = require("express-async-handler");
const Material = require("../models/materialModel");

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
const DEFAULT_QUOTA = Number(process.env.UPLOAD_QUOTA_BYTES || 4 * 1024 * 1024 * 1024); // 4GB

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

const quotaFor = (user) =>
  Number(user?.storageQuotaBytes) > 0 ? Number(user.storageQuotaBytes) : DEFAULT_QUOTA;

// Bytes this user already has stored.
async function usedBytes(userId) {
  const agg = await Material.aggregate([
    { $match: { owner: userId } },
    { $group: { _id: null, bytes: { $sum: { $ifNull: ["$sizeBytes", 0] } } } },
  ]);
  return agg[0]?.bytes || 0;
}

// Checked AFTER multer has written the file (it streams to disk as it arrives)
// but BEFORE any conversion runs — so an over-quota upload never reaches
// LibreOffice. The caller deletes the rejected file.
const storageQuota = asyncHandler(async (req, res, next) => {
  if (req.user?.role === "admin") return next();
  const incoming = Number(req.file?.size || 0);
  const limit = quotaFor(req.user);
  let used = 0;
  try {
    used = await usedBytes(req.user._id);
  } catch (e) {
    // Fail OPEN on a DB hiccup: the rate limiter and the per-file cap still
    // bound the damage, and blocking a real teacher over a transient error is
    // worse than letting one upload through.
    console.error("storageQuota aggregate failed (failing open):", e?.message);
    return next();
  }
  if (used + incoming > limit) {
    req.quotaRejected = {
      used,
      limit,
      incoming,
      message: `Yaddaş limiti dolub (${gb(limit)} GB). İstifadə olunub: ${gb(
        used
      )} GB, bu fayl: ${mb(incoming)} MB. Köhnə materialları silin və ya adminlə əlaqə saxlayın.`,
    };
  }
  next();
});

module.exports = { uploadRateLimit, storageQuota, usedBytes, quotaFor, DEFAULT_QUOTA };
