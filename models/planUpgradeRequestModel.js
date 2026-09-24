const mongoose = require("mongoose");
const { Schema } = mongoose;

// Manual paid-package upgrade request. A teacher taps "Yüksəlt" → this row is
// created and the admin is pinged; the admin confirms payment offline and flips
// the plan via PATCH /api/users/:id/plan, then marks the request done. It NEVER
// grants a plan by itself — it is a demand/queue signal only.
//
// At most ONE open request per {teacher, targetPlan} (partial unique index) so
// repeated taps are idempotent.
const planUpgradeRequestSchema = new Schema(
  {
    teacher: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // A plan upgrade, a credit top-up, or extra storage — one manual-payment queue.
    kind: { type: String, enum: ["plan", "credit", "storage"], default: "plan" },
    targetPlan: { type: String, enum: ["pro", "premium"] }, // for kind: "plan"
    credits: { type: Number, default: 0 }, // for kind: "credit"
    // for kind: "storage" — how much, and for how long. Months, because storage
    // is rented: see STORAGE_PACKS in config/plans.js.
    storageGb: { type: Number, default: 0 },
    months: { type: Number, default: 1 },
    status: { type: String, enum: ["open", "done", "rejected"], default: "open" },
    // The teacher tapped "Ödədim" after transferring to the card — a claim the
    // admin verifies before promoting. Just a signal; never auto-activates.
    paidClaimed: { type: Boolean, default: false },
    paidClaimedAt: { type: Date, default: null },
    note: { type: String, default: "", maxlength: 1000 },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "plan_upgrade_request" }
);

/*
 * One open PLAN request per teacher per target plan, so repeated taps are
 * idempotent.
 *
 * `kind` is in the filter now. Without it the index also covered credit and
 * storage requests — neither of which has a targetPlan, so both indexed as null
 * and a teacher with an open credit top-up could not ask for storage at all, or
 * for a second credit pack. The constraint was only ever meant for plans.
 */
planUpgradeRequestSchema.index(
  { teacher: 1, targetPlan: 1 },
  {
    name: "uniq_open_plan_request_v2",
    unique: true,
    partialFilterExpression: { status: "open", kind: "plan" },
  }
);
planUpgradeRequestSchema.index({ status: 1, createdAt: -1 }, { name: "plan_request_status" });

module.exports = mongoose.model("PlanUpgradeRequest", planUpgradeRequestSchema);
