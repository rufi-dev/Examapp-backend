const mongoose = require("mongoose");
const { Schema } = mongoose;

// A parent account ↔ a student account. Created when a parent enters the student's
// shareable parentCode (userController.getParentCode). One row per (parent, student)
// — a parent may link several children, and a child may be linked by both parents.
// Shaped after enrollmentModel (the join-by-code precedent).
const parentLinkSchema = new Schema(
  {
    parent: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Reserved for a future "teacher must approve this link" flow; auto-approved today
    // because the code itself is the shared secret.
    status: { type: String, enum: ["approved"], default: "approved", index: true },
  },
  { timestamps: true, minimize: false }
);

parentLinkSchema.index({ parent: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("ParentLink", parentLinkSchema);
