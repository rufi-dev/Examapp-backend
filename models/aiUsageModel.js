const mongoose = require("mongoose");

// One row per AI PDF extraction: who ran it, on which exam, the token breakdown,
// and the USD cost. Powers the admin-only AI usage dashboard.
const aiUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    exam: { type: mongoose.Schema.Types.ObjectId, ref: "Exam" },
    /*
     * Which AI operation produced this row, as a stable name from
     * config/aiOperations.js. Added when Lesson Studio started reporting its
     * spend: it has no exam to point at, so without this the admin page could
     * show the cost but not what bought it. Absent on older rows, which is fine —
     * everything that reads this table aggregates on `usd`.
     */
    operation: { type: String, default: "" },
    model: { type: String, default: "claude-opus-4-8" },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    usd: { type: Number, default: 0 },
    questions: { type: Number, default: 0 },
    // The lesson-material equivalent of `questions`: how big the document was
    // after the turn, so a cost can be read against what it actually produced.
    blocks: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AiUsage", aiUsageSchema);
