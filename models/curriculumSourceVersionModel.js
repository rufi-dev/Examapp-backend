/*
 * The immutable bytes a citation pins.
 *
 * States: staged -> ready -> superseded, plus a fenced `deleting`.
 *   staged      bytes are still being written/optimised; NOT citable
 *   ready       bytes are FINAL and hashed; the only state a NEW claim may take
 *   superseded  the teacher uploaded a replacement. The bytes STAY, and an
 *               already-pinned draft/job may still transfer onto a published
 *               version against them (CR-MSO-016) — replacement never invalidates
 *               an existing citation
 *   deleting    a fenced terminal state; only reachable when NO SourceReference
 *               exists, and the unlink happens after the transaction commits
 *
 * `sha256` is computed at the staged -> ready transition, AFTER the last
 * byte-mutating step — never at upload, which is the mistake that makes the
 * materials store unusable for this (its optimiser rewrites bytes post-upload and
 * again on first read).
 *
 * `refEpoch` is the fence that makes claim-vs-delete safe: both contend on THIS
 * row inside a transaction, so a claim can never land after deletion wins.
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const pageMapSchema = new Schema(
  {
    ranges: {
      type: [
        new Schema(
          {
            fromFileIndex: { type: Number, required: true },
            toFileIndex: { type: Number, required: true },
            style: { type: String, enum: ["arabic", "roman", "literal"], default: "arabic" },
            startLabel: { type: String, default: "" },
          },
          { _id: false }
        ),
      ],
      default: undefined,
    },
    // filePageIndex (as a string key) -> printed label. Labels are STRINGS: real
    // books use "iv", "A-12" and "124a".
    overrides: { type: Schema.Types.Mixed, default: undefined },
    anchors: {
      type: [
        new Schema(
          { filePageIndex: { type: Number, required: true }, label: { type: String, required: true } },
          { _id: false }
        ),
      ],
      default: undefined,
    },
  },
  { _id: false }
);

const curriculumSourceVersionSchema = new Schema(
  {
    source: { type: Schema.Types.ObjectId, ref: "CurriculumSource", required: true },
    versionNumber: { type: Number, required: true, min: 1 },
    storageKey: { type: String, required: true },
    ext: { type: String, default: ".pdf" },
    sha256: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    mime: { type: String, default: "application/pdf" },
    pageCount: { type: Number, default: 0 },
    pageMap: { type: pageMapSchema, default: undefined },
    state: { type: String, enum: ["staged", "ready", "superseded", "deleting"], default: "staged" },
    // Bumped by EVERY claim and read by the delete CAS. See services/curriculumSourceService.js.
    refEpoch: { type: Number, default: 0 },
    deleteToken: { type: String, default: null },
    // Keys of the page crops derived from THESE bytes. Recorded on the version so a
    // crop has a resolvable OWNER: without this a crop could only be protected by
    // the secrecy of its key, which is weaker than every other private asset here.
    // They also die with the version, so cleanup needs no separate sweeper.
    cropKeys: { type: [String], default: undefined },
    readyAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "curriculum_source_versions",
  }
);

curriculumSourceVersionSchema.index(
  { source: 1, versionNumber: 1 },
  { name: "uniq_source_version", unique: true }
);
curriculumSourceVersionSchema.index({ storageKey: 1 }, { name: "uniq_storage_key", unique: true });

module.exports = mongoose.model("CurriculumSourceVersion", curriculumSourceVersionSchema);
