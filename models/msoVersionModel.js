/*
 * An immutable published snapshot of an MSO. Same contract as
 * lessonPlanVersionModel: no state field (an immutable row cannot transition), so
 * archive visibility lives on MsoDocument.archivedAt and archiving releases no
 * source reference.
 *
 * Everything the teacher prints — student paper, teacher paper, answer key,
 * solutions, points summary and the 20-row analytics table — is rendered FROM this
 * one frozen `content`, so none of them can disagree with another.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;
const { makeImmutable, guardBulkWrite } = require("../helper/immutableVersion");

const msoVersionSchema = new Schema(
  {
    docId: { type: Schema.Types.ObjectId, ref: "MsoDocument", required: true },
    versionNumber: { type: Number, required: true, min: 1 },
    contentHash: { type: String, required: true },
    author: { type: Schema.Types.ObjectId, ref: "User", default: null },
    publishedAt: { type: Date, default: Date.now },
    content: { type: Schema.Types.Mixed, required: true },
    sourceVersions: { type: [{ type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion" }], default: undefined },
    sourceHashes: { type: [String], default: undefined },
    schemaVersion: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "mso_versions",
  }
);

msoVersionSchema.index({ docId: 1, versionNumber: 1 }, { name: "uniq_mso_version", unique: true });
msoVersionSchema.index({ docId: 1, contentHash: 1 }, { name: "uniq_mso_content", unique: true });

makeImmutable(msoVersionSchema, "MsoVersion");

module.exports = guardBulkWrite(mongoose.model("MsoVersion", msoVersionSchema), "MsoVersion");
