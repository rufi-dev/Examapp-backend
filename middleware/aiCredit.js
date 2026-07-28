/*
 * Teacher Success Journey — AI credit enforcement middleware (ADR §8; CR-122).
 *
 * chargeAi(operation) RESERVES before the handler and settles with an EXPLICIT
 * contract — it NEVER infers success from the HTTP status. The handler signals
 * usable output by calling `req.aiCredit.usable()` (JSON: after validating the
 * final payload; SSE: after the authoritative `done`). On response finish/close
 * we COMMIT iff usable() was called, else RELEASE (provider error, empty/invalid
 * output, or disconnect-before-done). Settlement failures are NOT swallowed —
 * they retry with backoff and emit a bounded security metric; the reservation
 * TTL + recoverStaleReservations() are the durable backstop.
 *
 * Enforcement applies only when the flag is on AND the caller is a teacher.
 * Admins/anon are unmetered; essential grading routes never carry this. The
 * idempotency id is a validated X-AI-Idempotency-Key (one stable id per logical
 * action, reused for retry/SSE-reconnect/refresh) or a server-generated one.
 */
const asyncHandler = require("express-async-handler");
const crypto = require("crypto");
const creditSvc = require("../services/aiCreditService");
const { isJourneyEnabled } = require("../config/teacherSuccess/flag");
const { weightFor } = require("../config/teacherSuccess/aiCredits");

const CLIENT_REQ_ID_RE = /^[A-Za-z0-9._:-]{8,200}$/;

async function settleWithRetry(fn, ctx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (attempt === 2) {
        // Bounded, label-safe security metric — never swallow silently.
        console.warn("[SECURITY] tsj_settlement_failed", JSON.stringify({ op: ctx.operation, kind: ctx.kind, teacher: String(ctx.teacherId).slice(-6), err: String(e && e.message).slice(0, 120) }));
        return { ok: false, error: true };
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

function chargeAi(operation) {
  weightFor(operation); // fail fast on a typo at wire time
  return asyncHandler(async (req, res, next) => {
    if (!isJourneyEnabled() || !req.user || req.user.role !== "teacher") return next();

    const teacherId = req.user._id;
    const level = req.user.teacherLevel || "spark";
    const headerId = req.get("x-ai-idempotency-key");
    const clientReqId = headerId && CLIENT_REQ_ID_RE.test(headerId) ? headerId : `srv.${operation}.${crypto.randomBytes(9).toString("hex")}`;

    const r = await creditSvc.reserve(teacherId, { operation, clientReqId, level });
    if (!r.ok) { res.status(429); return res.json({ code: "ai_credit_exhausted", remaining: r.remaining, resetAt: r.resetAt }); }

    // EXPLICIT settlement signal — the handler calls usable() on real output.
    let markedUsable = false;
    const periodMonthUtc = r.periodMonthUtc;
    req.aiCredit = { operation, clientReqId, periodMonthUtc, reserved: r.reserved, usable: () => { markedUsable = true; } };

    let settled = false;
    const settle = () => {
      if (settled) return; settled = true;
      // Free op (nothing reserved) needs no settlement.
      if (!r.reserved) return;
      if (markedUsable) settleWithRetry(() => creditSvc.commit(teacherId, { operation, clientReqId, periodMonthUtc }), { operation, kind: "commit", teacherId });
      else settleWithRetry(() => creditSvc.release(teacherId, { operation, clientReqId, periodMonthUtc }), { operation, kind: "release", teacherId });
    };
    res.on("finish", settle);
    res.on("close", () => { if (!res.writableFinished) settle(); });
    next();
  });
}

module.exports = { chargeAi };
