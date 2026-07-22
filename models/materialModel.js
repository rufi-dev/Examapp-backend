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
    // Optional banner picked by the teacher. Display-only Cloudinary URL, so
    // it is safe to send to students; without one the card draws its own.
    coverImage: {
      type: String,
      default: "",
    },
    description: { type: String, trim: true, default: "" },

    // Stored file name inside materials/ (random, not the original name).
    fileName: { type: String, required: true },
    originalName: { type: String, trim: true, default: "" },
    kind: { type: String, enum: ["pdf", "image"], required: true },
    mimeType: { type: String, default: "" },
    sizeBytes: { type: Number, default: 0 },

    // Audience. EMPTY = shared with all of this teacher's students; otherwise
    // only the listed classes see it.
    classes: [{ type: Schema.Types.ObjectId, ref: "Class", index: true }],
    // Legacy single-class field kept so material published before multi-class
    // support keeps its audience. Reads prefer `classes` when it is non-empty.
    class: { type: Schema.Types.ObjectId, ref: "Class", default: null, index: true },

    // Locked by default: the material can be READ in the in-app viewer but not
    // downloaded. A teacher can flip this per material (e.g. a worksheet to print).
    allowDownload: { type: Boolean, default: false },

    // Off by default: the viewer renders the PDF without a text layer, so there
    // is nothing to select. Turning this on renders the text layer and lets a
    // student select/copy passages (useful for notes the teacher wants quoted).
    allowCopy: { type: Boolean, default: false },

    // Public share link. The token is the whole secret, so it is long and
    // random; the material id never appears in a shared URL. `enabled` is the
    // kill switch — flipping it off closes existing links immediately without
    // destroying the token, so turning sharing back on does not break a link
    // the teacher has already sent out.
    //
    // `requireAuth` is the teacher's choice at share time: off means anyone
    // with the link reads it, on means they must sign in first — which is the
    // only way `readers` below can be filled in.
    share: {
      enabled: { type: Boolean, default: false },
      token: { type: String, index: true, sparse: true },
      requireAuth: { type: Boolean, default: false },
      createdAt: { type: Date },
      // Total opens, counted whether or not sign-in is required.
      views: { type: Number, default: 0 },
      // Who opened it, one entry per person (last-seen wins) rather than a raw
      // log — "who has read this" is the question a teacher actually asks.
      // Only fills when requireAuth is on; capped so it cannot grow forever.
      readers: [
        {
          _id: false,
          user: { type: Schema.Types.ObjectId, ref: "User" },
          name: { type: String, trim: true },
          email: { type: String, trim: true },
          at: { type: Date },
        },
      ],
    },

    owner: { type: Schema.Types.ObjectId, ref: "User", index: true },
    ownerName: { type: String, trim: true },
  },
  { timestamps: true }
);

// Newest-first listing per owner is the common query.
materialSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model("Material", materialSchema);
