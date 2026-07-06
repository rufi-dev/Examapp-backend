const asyncHandler = require("express-async-handler");
const AiUsage = require("../models/aiUsageModel");

// ---------------------------------------------------------------------------
// AI abuse / cost protection. The AI routes call paid providers (Anthropic,
// OpenAI, Gemini) and anyone can self-assign the teacher role, so without a
// guard a single account (or script) could drain the API balance. Two layers:
//   1) aiRateLimit  — per-user request rate (in-memory, single container).
//   2) aiBudgetGuard — per-user DAILY USD cap, summed from AiUsage.
// Both are env-tunable; admins are uncapped.
// ---------------------------------------------------------------------------

const WINDOW_MS = Number(process.env.AI_RATE_WINDOW_MS || 10 * 60 * 1000); // 10 min
const MAX_PER_WINDOW = Number(process.env.AI_RATE_MAX || 40);
const DAILY_USD_CAP = Number(process.env.AI_DAILY_USD_CAP || 3);

// userId -> { count, resetAt }. Pruned lazily so the Map can't grow unbounded.
const hits = new Map();

function aiRateLimit(req, res, next) {
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
    res.set("Retry-After", String(Math.ceil((e.resetAt - now) / 1000)));
    res.status(429);
    throw new Error("Çox sayda AI sorğusu göndərdiniz. Bir azdan yenidən cəhd edin.");
  }
  next();
}

// Reject a paid AI call once the user has spent >= their daily cap today.
// Admins are exempt. A DB hiccup fails OPEN (never blocks a real teacher over a
// transient error) — the rate limiter still bounds the blast radius.
const aiBudgetGuard = asyncHandler(async (req, res, next) => {
  if (req.user?.role === "admin" || DAILY_USD_CAP <= 0) return next();
  let spent = 0;
  try {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const agg = await AiUsage.aggregate([
      { $match: { user: req.user._id, createdAt: { $gte: since } } },
      { $group: { _id: null, usd: { $sum: "$usd" } } },
    ]);
    spent = agg[0]?.usd || 0;
  } catch (e) {
    console.error("aiBudgetGuard aggregate failed (failing open):", e?.message);
    return next();
  }
  if (spent >= DAILY_USD_CAP) {
    res.status(429);
    throw new Error(
      "Günlük AI limitiniz doldu. Sabah yenidən cəhd edin və ya dəstəklə əlaqə saxlayın."
    );
  }
  next();
});

module.exports = { aiRateLimit, aiBudgetGuard };
