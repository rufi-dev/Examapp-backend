const mongoose = require("mongoose");
const { Schema } = mongoose;
const { ONBOARDING_IDS } = require("../config/teacherSuccess/missions");

/*
 * Teacher Journey — mission progress (one row per teacher+mission). Missions are
 * DERIVED from real committed server data; this row caches the derived progress and,
 * critically, stamps `completedAt` once the underlying real action succeeds so the
 * completion time is stable. There is no client "complete" action.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherMissionProgressSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    missionId: { type: String, enum: ONBOARDING_IDS, required: true },
    status: { type: String, enum: ["locked", "active", "complete"], default: "locked" },
    progressCurrent: { type: Number, default: 0 },
    progressTarget: { type: Number, default: 1 },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_mission_progress" }
);

teacherMissionProgressSchema.index({ teacherId: 1, missionId: 1 }, { name: "uniq_mission", unique: true });

module.exports = mongoose.model("TeacherMissionProgress", teacherMissionProgressSchema);
