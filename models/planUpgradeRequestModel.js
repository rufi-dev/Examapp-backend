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
    // A plan upgrade OR a credit top-up purchase (same manual-payment queue).
    kind: { type: String, enum: ["plan", "credit"], default: "plan" },
    targetPlan: { type: String, enum: ["pro", "premium"] }, // for kind: "plan"
    credits: { type: Number, default: 0 }, // for kind: "credit"
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

planUpgradeRequestSchema.index(
  { teacher: 1, targetPlan: 1 },
  { name: "uniq_open_plan_request", unique: true, partialFilterExpression: { status: "open" } }
);
planUpgradeRequestSchema.index({ status: 1, createdAt: -1 }, { name: "plan_request_status" });

module.exports = mongoose.model("PlanUpgradeRequest", planUpgradeRequestSchema);
