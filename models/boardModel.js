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
    // Homework solve-board: when set, this board belongs to ONE student for ONE
    // assignment — only that student (+ owner/admin) may open it, and the student may
    // EDIT it (write their solution). See boardAccessService.accessLevel.
    assignment: { type: Schema.Types.ObjectId, ref: "Assignment", default: null, index: true },
    student: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    // Annotation board: the teacher marks a student's submitted image on a full board
    // (all custom tools). `submission` + `sourceFileName` link back so "send to student"
    // exports the marked PNG onto that submission. Owner-only (no student edit).
    submission: { type: Schema.Types.ObjectId, ref: "Submission", default: null, index: true },
    sourceFileName: { type: String, default: "" },
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
    // The id of the last live-session journal whose scene was persisted into this
    // board. Set atomically with the scene on every live checkpoint + recovery, so
    // boot replay can PROVE a journal was already applied (idempotent recovery)
    // before deleting it. See realtime/boardJournal.js + boardHub replayJournals.
    lastLiveJournalId: { type: String, default: null },
    // DURABLE live-session identity (CR-BOARD-010). `active` is true between an
    // explicit start and an explicit end — it OUTLIVES memory eviction (the 2h idle
    // reaper) and a backend restart, so the same session id can be rehydrated from
    // the saved scene on reconnect. ONLY an explicit end-live clears `active`; the
    // reaper/shutdown drop the in-memory room but keep the session active.
    liveSession: {
      id: { type: String, default: null },
      active: { type: Boolean, default: false },
      pageId: { type: String, default: null },
      startedAt: { type: Date, default: null },
    },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true, minimize: false }
);

boardSchema.index({ owner: 1, deletedAt: 1, updatedAt: -1 });

module.exports = mongoose.model("Board", boardSchema);
