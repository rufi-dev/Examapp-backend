const mongoose = require("mongoose");

const schema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    status: { type: String, enum: ["processing", "processed", "failed"], default: "processing" },
    error: { type: String, default: "" },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "stripe_events" }
);

module.exports = mongoose.models.StripeEvent || mongoose.model("StripeEvent", schema);
