const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Success Journey — referral records (ADR §7).
 *
 * One row per referee (the newly-registered user), UNIQUE on refereeId so a
 * user can be referred at most once. Lifecycle: pending -> qualified -> rewarded,
 * plus terminal/review states held | rejected | revoked. Evidence, risk reasons,
 * reviewer, and an idempotent reward key are stored so a reward is applied at
 * most once and every decision is auditable. A signup alone never qualifies; a
 * qualified referral makes the REFERRER eligible for review (not auto-promoted).
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherReferralSchema = new Schema(
  {
    referrerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    refereeId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    code: { type: String, required: true }, // the referrer's share code used
    state: {
      type: String,
      enum: ["pending", "qualified", "rewarded", "held", "rejected", "revoked"],
      default: "pending",
    },
    // Bounded, label-safe evidence + risk reasons (no PII-heavy blobs).
    evidence: { type: Schema.Types.Mixed, default: undefined },
    riskReasons: { type: [String], default: [] },
    reviewer: { type: Schema.Types.ObjectId, ref: "User", default: null },
    reason: { type: String, default: null, maxlength: 500 },
    // Idempotent reward key — a unique index guarantees the reward side effect
    // (referrer eligibility credit) is applied at most once even under retries.
    rewardKey: { type: String, default: null },
    qualifiedAt: { type: Date, default: null },
    rewardedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_referral" }
);

// Migration-owned; mirrored in helper/teacherSuccessIndexes.js.
teacherReferralSchema.index({ refereeId: 1 }, { name: "uniq_referee", unique: true });
teacherReferralSchema.index({ referrerId: 1, state: 1 }, { name: "ref_referrer_state" });
teacherReferralSchema.index(
  { rewardKey: 1 },
  { name: "uniq_reward_key", unique: true, partialFilterExpression: { rewardKey: { $type: "string" } } }
);

module.exports = mongoose.model("TeacherReferral", teacherReferralSchema);
