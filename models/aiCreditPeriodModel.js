const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Success Journey — per-teacher monthly AI credit accounting boundary
 * (ADR §8.3/§8.4). Unique {teacherId, periodMonthUtc} where periodMonthUtc is
 * the UTC calendar month "YYYY-MM". This is a SEPARATE accounting boundary from
 * AiUsage (which stays for provider/token/cost observability). NEVER an
 * unbounded array on User (D15).
 *
 * Invariant: used + reserved <= baseAllowance + tempGranted, enforced atomically
 * by the credit service's conditional updates (no overspend). `baseAllowance`
 * reflects the teacher's level ceiling AT THE TIME credits were consumed;
 * promotion mid-month raises it immediately (consumed credits stay consumed).
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const aiCreditPeriodSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    periodMonthUtc: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    baseAllowance: { type: Number, required: true, min: 0 },
    used: { type: Number, default: 0, min: 0 },
    reserved: { type: Number, default: 0, min: 0 },
    tempGranted: { type: Number, default: 0, min: 0 },
    // The level the base allowance was derived from (observability; not authz).
    levelAtOpen: { type: String, enum: ["spark", "momentum", "impact"], default: "spark" },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "ai_credit_period" }
);

// Migration-owned; mirrored in helper/teacherSuccessIndexes.js.
aiCreditPeriodSchema.index({ teacherId: 1, periodMonthUtc: 1 }, { name: "uniq_teacher_period", unique: true });

module.exports = mongoose.model("AiCreditPeriod", aiCreditPeriodSchema);
