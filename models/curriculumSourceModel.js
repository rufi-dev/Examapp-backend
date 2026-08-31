/*
 * A curriculum source = one textbook (or chapter) a teacher uploads so citations
 * can point at real pages. The BYTES live in a CurriculumSourceVersion; this row
 * is the stable identity a teacher sees and picks.
 *
 * autoIndex/autoCreate off — migrations/2026-09-01-curriculum.js owns the
 * collection + indexes, so a flag-off application startup performs zero schema
 * writes (helper/curriculumIndexes.js is the single BUILD + VERIFY contract).
 */
const mongoose = require("mongoose");
const { Schema } = mongoose;

const curriculumSourceSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: false },
    title: { type: String, required: true, trim: true, maxlength: 300 },
    subject: { type: String, trim: true, maxlength: 120, default: "" },
    grade: { type: String, trim: true, maxlength: 40, default: "" },
    textbookEdition: { type: String, trim: true, maxlength: 200, default: "" },
    // The version a NEW document should pin. Old versions stay reachable — an
    // already-pinned draft must still be able to publish against its exact bytes.
    activeVersion: { type: Schema.Types.ObjectId, ref: "CurriculumSourceVersion", default: null },
    activeVersionNumber: { type: Number, default: 0 },
    // A cached PROJECTION of SourceReference, never the deletion authority.
    // Deletion asks the reference collection; this exists only so a list view can
    // show "in use" without an extra aggregate. Reconciled by the sweeper.
    refCount: { type: Number, default: 0, min: 0 },
    archivedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "curriculum_sources",
  }
);

curriculumSourceSchema.index({ owner: 1, createdAt: -1 }, { name: "owner_1_createdAt_-1" });

module.exports = mongoose.model("CurriculumSource", curriculumSourceSchema);
