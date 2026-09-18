const mongoose = require("mongoose");
const { isOversizeError, tooLargeError } = require("../helper/boardSize");
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
    // Solve-board: once the student submits it to the teacher, it locks (read-only);
    // they may start a NEW board if the assignment rules allow.
    submitted: { type: Boolean, default: false },
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

/*
 * Write a board's scene through the MongoDB driver, not Mongoose.
 *
 * A handwriting board is thousands of freedraw strokes in a Mixed field. Measured
 * on a real one (5.3 MB, 4,220 strokes on one page): Mongoose's findOneAndUpdate
 * held the event loop for 1.3–2.0 s per save, the driver for 0.16–0.25 s. The
 * server is single-threaded, so for those seconds EVERY request and every live
 * board waited — and the editor saves every few seconds while a teacher writes.
 * A teacher's board "froze" mid-lesson (2026-09-16).
 *
 * The scene is opaque to the schema anyway, so Mongoose's walk bought nothing.
 * What it did do is done here: ids are cast, and `updatedAt` is stamped (the
 * schema's timestamps). Returns the updated document limited to `projection`,
 * or null when the filter (the revision CAS) did not match.
 */
const asId = (v) =>
  typeof v === "string" && mongoose.Types.ObjectId.isValid(v) && /^[0-9a-f]{24}$/i.test(v) ? new mongoose.Types.ObjectId(v) : v;

boardSchema.statics.writeScene = async function writeScene(filter, update, projection) {
  const f = { ...filter };
  for (const k of ["_id", "owner", "pages._id"]) if (k in f) f[k] = asId(f[k]);
  const $set = { ...(update.$set || {}), updatedAt: new Date() };
  if (Array.isArray($set.classes)) $set.classes = $set.classes.map(asId);
  let r;
  try {
    r = await this.collection.findOneAndUpdate(
      f,
      { ...update, $set },
      { returnDocument: "after", projection, includeResultMetadata: true }
    );
  } catch (e) {
    // Last safety net: callers measure the candidate document first, so a size
    // rejection HERE means something was not accounted for. It must still surface
    // as the one typed failure every caller handles — never a raw RangeError 500.
    if (isOversizeError(e)) throw tooLargeError(0);
    throw e;
  }
  return (r && r.value) || null;
};

module.exports = mongoose.model("Board", boardSchema);
