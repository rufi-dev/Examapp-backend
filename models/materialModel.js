const mongoose = require("mongoose");
const { Schema } = mongoose;

// A teacher-shared study material (PDF / image). Word & PowerPoint uploads are
// converted to PDF on upload, so `kind` is always "pdf" or "image" and the
// viewer only ever has two cases to render.
//
// The file itself lives in the PRIVATE materials/ directory — it is NOT served
// by express.static (unlike uploads/), so the only way to read it is through
// GET /api/materials/:id/file, which checks the caller's access first. That is
// what makes "students can read it but can't grab the file URL" hold.
//
// Visibility mirrors the rest of the platform (see materialController.getMaterials):
//   • admin   → everything
//   • teacher → only their own uploads
//   • student → materials from teachers whose classes they're approved-enrolled
//               in, limited to materials shared with ALL students (class: null)
//               or with a class they're actually in.
const materialSchema = Schema(
  {
    title: { type: String, trim: true, required: true },
    description: { type: String, trim: true, default: "" },

    // Stored file name inside materials/ (random, not the original name).
    fileName: { type: String, required: true },
    originalName: { type: String, trim: true, default: "" },
    kind: { type: String, enum: ["pdf", "image"], required: true },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },

    // Optional class scope. null = shared with all of this teacher's students.
    class: { type: Schema.Types.ObjectId, ref: "Class", default: null, index: true },

    // Locked by default: the material can be READ in the in-app viewer but not
    // downloaded. A teacher can flip this per material (e.g. a worksheet to print).
    allowDownload: { type: Boolean, default: false },

    // Off by default: the viewer renders the PDF without a text layer, so there
    // is nothing to select. Turning this on renders the text layer and lets a
    // student select/copy passages (useful for notes the teacher wants quoted).
    allowCopy: { type: Boolean, default: false },

    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerName: { type: String, trim: true },
  },
  { timestamps: true }
);

// Newest-first listing per owner is the common query.
materialSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("Material", materialSchema);
