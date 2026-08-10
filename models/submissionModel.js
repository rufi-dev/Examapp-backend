const mongoose = require("mongoose");
const { Schema } = mongoose;

// A student's uploaded work for one Assignment. The files live in the PRIVATE
// assignments/ directory (see assignmentController) and are only readable by the
// student who owns them and the teacher who owns the class — never by URL.
//
// One submission per (assignment, student): a student can re-upload (which
// REPLACES the previous files) up to the deadline, so there is exactly one row
// per student per task, not a history. `late` is stamped once, at submit time,
// against the assignment's dueAt.
const submittedFileSchema = new Schema(
  {
    fileName: { type: String, required: true },
    originalName: { type: String, trim: true, default: "" },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },
    kind: { type: String, default: "other" }, // pdf | image | office | other
  },
  { _id: false }
);

const submissionSchema = Schema(
  {
    assignment: { type: Schema.Types.ObjectId, ref: "Assignment", required: true, index: true },
    // Denormalised so the teacher can scope by class without a join.
    class: { type: Schema.Types.ObjectId, ref: "Class", index: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    studentName: { type: String, trim: true },

    // The uploaded work. At least one file per submission.
    files: { type: [submittedFileSchema], default: [] },
    // Optional short note the student attaches ("Sual 3-ü tam bitirə bilmədim").
    note: { type: String, trim: true, default: "" },

    submittedAt: { type: Date, default: Date.now },
    // Stamped at submit time: submittedAt was after the assignment's dueAt.
    late: { type: Boolean, default: false },

    // "submitted" = waiting for the teacher. "returned" = teacher graded/gave
    // feedback and handed it back (grade/feedback below are then meaningful).
    status: { type: String, enum: ["submitted", "returned"], default: "submitted", index: true },
    grade: { type: Number, default: null },
    feedback: { type: String, trim: true, default: "" },
    gradedAt: { type: Date, default: null },
    gradedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, minimize: false }
);

// Exactly one submission per student per task.
submissionSchema.index({ assignment: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("Submission", submissionSchema);
