const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * Teacher Journey — the PROJECTED XP rollup per teacher (a fast-read cache). It is
 * ALWAYS reconstructable from the immutable teacher_xp_event ledger (teacherXpService
 * .reconcile rebuilds it exactly), so this row is an optimization, never the source of
 * truth. Updated in the SAME transaction as each ledger append so it can never drift.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherXpStateSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lifetimeXp: { type: Number, default: 0 }, // SUM(amount) over the ledger
    byType: { type: Schema.Types.Mixed, default: () => ({}) }, // { type -> count of events }
    lastEventAt: { type: Date, default: null },
    version: { type: Number, default: 0 }, // bumped on each projection write (optimistic)
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_xp_state" }
);

teacherXpStateSchema.index({ teacherId: 1 }, { name: "uniq_xp_state_teacher", unique: true });

module.exports = mongoose.model("TeacherXpState", teacherXpStateSchema);
