const mongoose = require("mongoose");
const { Schema } = mongoose;

// CR-035: a durable audit record for every privileged maintenance operation on
// otherwise-immutable data (e.g. deleting a published ExamVersion during a rollback).
// Written BEFORE the operation runs, so an authorized mutation always leaves a trail.
const maintenanceAuditSchema = new Schema(
  {
    action: { type: String, required: true },   // e.g. "exam_version_delete"
    actor: { type: String, required: true },     // who authorized it (user id / "migration:<name>")
    reason: { type: String, required: true },     // why
    target: { type: Schema.Types.Mixed, default: null }, // affected ids/filter
    at: { type: Date, required: true },
  },
  { minimize: false }
);

module.exports = mongoose.model("MaintenanceAudit", maintenanceAuditSchema);
