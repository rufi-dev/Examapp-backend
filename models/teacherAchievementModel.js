const mongoose = require("mongoose");
const { Schema } = mongoose;
const { ACHIEVEMENT_IDS } = require("../config/teacherSuccess/achievements");

/*
 * Teacher Journey — earned achievement badges (one row per teacher+achievement).
 * DERIVED from server-authoritative events/metrics — never claimed by the client.
 * Earned at most once (unique index) and stamped `earnedAt`.
 *
 * autoIndex/autoCreate off — the Journey migration owns the collection + indexes.
 */
const teacherAchievementSchema = new Schema(
  {
    teacherId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    achievementId: { type: String, enum: ACHIEVEMENT_IDS, required: true },
    earnedAt: { type: Date, default: Date.now },
    sourceEventId: { type: Schema.Types.ObjectId, ref: "TeacherXpEvent", default: null },
  },
  { timestamps: true, minimize: false, autoIndex: false, autoCreate: false, collection: "teacher_achievement" }
);

teacherAchievementSchema.index({ teacherId: 1, achievementId: 1 }, { name: "uniq_ach", unique: true });

module.exports = mongoose.model("TeacherAchievement", teacherAchievementSchema);
