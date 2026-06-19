const mongoose = require("mongoose");

// One row per AI PDF extraction: who ran it, on which exam, the token breakdown,
// and the USD cost. Powers the admin-only AI usage dashboard.
const aiUsageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    exam: { type: mongoose.Schema.Types.ObjectId, ref: "Exam" },
    model: { type: String, default: "claude-opus-4-8" },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    usd: { type: Number, default: 0 },
    questions: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AiUsage", aiUsageSchema);
