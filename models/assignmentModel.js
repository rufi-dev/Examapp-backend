const mongoose = require("mongoose");
const { Schema } = mongoose;

// A homework task a teacher posts inside a class ("Tapşırıq"). Students upload
// their own work against it (see submissionModel.js). This is the university /
// Moodle / Google Classroom model: one task, many student submissions.
//
// Attachment files (an optional worksheet/brief the teacher hands out) live in
// the PRIVATE assignments/ directory alongside student submissions — NOT under
// express.static — so the only way to read one is through an access-checked
// endpoint in assignmentController. Same guarantee the materials/ dir gives.
const attachedFileSchema = new Schema(
  {
    // Stored file name inside assignments/ (random, not the original name).
    fileName: { type: String, required: true },
    originalName: { type: String, trim: true, default: "" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    // Coarse bucket for the UI icon: "pdf" | "image" | "office" | "other".
    kind: { type: String, default: "other" },
  },
  { _id: false }
);

const assignmentSchema = Schema(
  {
    class: { type: Schema.Types.ObjectId, ref: "Class", required: true, index: true },
    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerName: { type: String, trim: true },

    title: { type: String, trim: true, required: true },
    // Instructions / brief for the task. Plain text.
    description: { type: String, trim: true, default: "" },

    // Optional files the teacher hands out with the task (a worksheet, a rubric).
    attachments: { type: [attachedFileSchema], default: [] },

    // The deadline. null = no deadline (open-ended). Submissions after this are
    // flagged `late`; whether they are ACCEPTED depends on `allowLate`.
    dueAt: { type: Date, default: null },
    // true  = a student may still submit after dueAt (flagged late, not blocked).
    // false = the upload endpoint refuses once the deadline has passed.
    allowLate: { type: Boolean, default: true },

    // Optional grading ceiling. null = collect-only (no numeric grade); a number
    // turns on point grading (0..maxPoints) in the teacher's review panel.
    maxPoints: { type: Number, default: null, min: 0 },

    // true = a student may submit exactly ONCE; the upload endpoint then refuses
    // any re-upload, so they cannot edit, add, or remove files afterwards. The
    // student is warned before that final submit. false = free re-uploads (default).
    lockAfterSubmit: { type: Boolean, default: false },

    // true = students can solve this task directly on their own whiteboard (a
    // per-student board is created on demand). They can still upload files too.
    boardEnabled: { type: Boolean, default: false },

    deletedAt: { type: Date, default: null, index: true },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

// The common query: a class's live tasks, newest deadline / newest first.
assignmentSchema.index({ class: 1, deletedAt: 1, createdAt: -1 });

module.exports = mongoose.model("Assignment", assignmentSchema);
