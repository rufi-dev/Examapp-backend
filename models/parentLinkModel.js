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
    // "approved" = active link (code entry, or after approval). "pending" = an
    // email-based request awaiting the student's or a teacher's approval (email is
    // guessable, so it can't auto-link). Code entry is always approved.
    status: { type: String, enum: ["approved", "pending"], default: "approved", index: true },
    // How the link was requested — for display/audit.
    via: { type: String, enum: ["code", "email"], default: "code" },
  },
  { timestamps: true, minimize: false }
);

parentLinkSchema.index({ parent: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("ParentLink", parentLinkSchema);
