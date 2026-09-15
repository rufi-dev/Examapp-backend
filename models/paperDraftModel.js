const mongoose = require("mongoose");
const { Schema } = mongoose;

// A student's in-progress self-upload of a paper exam answer sheet: the photos,
// what the AI read, and the student's corrections. Kept server-side so a refresh
// never loses the work and so AI reads can be limited per student. Deleted once
// the sheet is submitted (the Result is the permanent record).
const paperDraftSchema = new Schema(
  {
    exam: { type: Schema.Types.ObjectId, ref: "Exam", required: true },
    student: { type: Schema.Types.ObjectId, ref: "User", required: true },
    photos: [{ type: String }],
    // Plain answer values, one per key question (no key information).
    answers: { type: Schema.Types.Mixed, default: undefined },
    // What the machine read (platform, then AI for the unclear ones):
    // [{ answer, confidence, note, source: "omr" | "ocr" | "ai" | null }].
    aiAnswers: { type: Schema.Types.Mixed, default: undefined },
    // Question indices the platform couldn't read — waiting for the AI check.
    unresolved: { type: [Number], default: undefined },
    // Name/class boxes read off the sheet.
    sheetStudent: { type: Schema.Types.Mixed, default: undefined },
    // AI fallback checks used (each is a paid model call).
    readCount: { type: Number, default: 0 },
    // Platform reads used (OMR + OCR; cheap but not free).
    platformReadCount: { type: Number, default: 0 },
    // Submit lock: set while a submit is being processed.
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

// One draft per student per exam — also what makes the submit lock atomic.
paperDraftSchema.index({ exam: 1, student: 1 }, { unique: true });

module.exports = mongoose.model("PaperDraft", paperDraftSchema);
