const mongoose = require("mongoose");
const { Schema } = mongoose;

// One page of a board — its own Excalidraw scene. A board holds an ordered list
// of pages so a teacher can keep several canvases (topics) in a single board.
const boardPageSchema = new Schema(
  {
    name: { type: String, trim: true, default: "Səhifə" },
    // { elements: [...], appState: {...}, files: {...} } — null until first drawn.
    scene: { type: Schema.Types.Mixed, default: null },
  },
  { _id: true, minimize: false }
);

// A teacher's whiteboard ("Lövhə"). Pages + audience arrive via a multipart upload
// so they bypass the 100KB global JSON parser; kept in Mongo (under the 16MB doc
// cap for normal drawing boards). Sharing mirrors study materials: EMPTY classes =
// shared with ALL of this teacher's students; otherwise only the listed classes.
const boardSchema = Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ownerName: { type: String, trim: true },
    title: { type: String, trim: true, default: "Adsız lövhə" },
    // Canvas background pattern (a graph-paper feel): dots | grid | lines | blank.
    background: { type: String, enum: ["dots", "grid", "lines", "blank"], default: "blank" },
    // Base canvas colour behind the pattern ("" = default white/dark surface).
    bgColor: { type: String, default: "" },
    pages: { type: [boardPageSchema], default: [] },
    // Audience (like materials/videos): [] = all of this teacher's students;
    // otherwise only students of the listed classes. Students always read-only.
    classes: [{ type: Schema.Types.ObjectId, ref: "Class", index: true }],
    // Legacy single-scene field (boards made before multi-page). Read-migrated to
    // pages[0] on load; never written anymore.
    scene: { type: Schema.Types.Mixed, default: null },
    elementCount: { type: Number, default: 0 },
    sizeBytes: { type: Number, default: 0 },
    // Optimistic-concurrency counter. Every persisted mutation does a CAS on this
    // (see boardController.saveBoard + the live hub's checkpoint) so a stale tab
    // or a second writer cannot clobber newer work. Legacy docs lack it; the first
    // CAS matches `{ $in: [expected, null] }` (absent-safe). Each page also has a
    // stable `_id` (pageId) so writes target one page, never a whole-array replace.
    revision: { type: Number, default: 0 },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, minimize: false }
);

boardSchema.index({ owner: 1, deletedAt: 1, updatedAt: -1 });

module.exports = mongoose.model("Board", boardSchema);
