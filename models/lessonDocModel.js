const mongoose = require("mongoose");
const { Schema } = mongoose;

/*
 * A lesson MATERIAL — the handout a teacher gives a class to explain a topic.
 *
 * Distinct from LessonPlan, which is the teacher's own script for running an hour.
 * This is the thing the students read: an explanation, worked examples, definitions,
 * practice. It is written through a conversation and ends up as a PDF or a Word
 * file.
 *
 * WHY TYPED BLOCKS RATHER THAN A BLOB OF RICH TEXT.
 * Free-form HTML would be quicker to generate and impossible to do anything useful
 * with afterwards: it cannot be laid out consistently in print, a model cannot edit
 * one part of it without rewriting the rest, and the teacher cannot be given
 * per-section controls. A list of typed blocks gives all three — the renderer knows
 * what a definition looks like, an AI edit can target block 4, and the editor can
 * offer the right fields per kind.
 */

const BLOCK_KINDS = [
  "heading", // a section title
  "text", // explanatory prose
  "list", // bullets or steps
  "definition", // term + meaning, set apart
  "example", // a worked example, usually with a solution
  "task", // something for the student to do
  "note", // an aside: a warning, a tip, a reminder
  "table", // rows and columns
  "figure", // a diagram the model drew, as sanitised SVG
];

const blockSchema = new Schema(
  {
    // Stable across edits so an AI change to block 4 stays block 4 — and so the
    // editor's React keys do not reshuffle the whole document on every save.
    id: { type: String, required: true },
    kind: { type: String, enum: BLOCK_KINDS, required: true },

    text: { type: String, default: "" }, // heading / text / note / task body
    term: { type: String, default: "" }, // definition
    items: { type: [String], default: undefined }, // list
    ordered: { type: Boolean, default: undefined }, // list: numbered vs bulleted
    solution: { type: String, default: "" }, // example / task
    // table: a header row plus body rows, both plain strings.
    columns: { type: [String], default: undefined },
    rows: { type: [[String]], default: undefined },
    // note: what kind of aside it is, which drives the colour in print.
    tone: { type: String, enum: ["info", "warning", "success"], default: "info" },
    // figure: sanitised SVG. Stored as text because that is what it is — and what
    // lets a teacher edit a label without regenerating the drawing.
    svg: { type: String, default: "" },
  },
  { _id: false }
);

/*
 * One turn of the conversation. Kept ON the document rather than in a separate
 * collection: the chat has no meaning apart from the document it produced, and a
 * teacher reopening a material wants to see how they asked for it.
 */
const messageSchema = new Schema(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    text: { type: String, default: "" },
    // What the assistant did, so the transcript can show it without re-deriving:
    // "created" | "edited" | "failed".
    action: { type: String, default: "" },
    // Counts beside the words, so the UI can show a receipt without re-deriving it.
    stats: { type: Schema.Types.Mixed, default: undefined },
    /*
     * What the turn actually did, kept so it can be reopened later.
     *
     * The live report used to exist only for the length of the request: the
     * sources it read and the steps it committed to were on screen while it
     * worked and gone the moment it finished, so "what did it use to write this?"
     * was unanswerable an hour afterwards. Stored with the message it produced —
     * `{ sources: [{name, found, readable}], steps: [{heading, why}] }`.
     */
    work: { type: Schema.Types.Mixed, default: undefined },
    /*
     * Which references were in front of the model on THIS turn.
     *
     * Not derivable from `files`, which is the document's current attachment list:
     * a teacher who attaches a textbook, asks two questions, removes it and asks a
     * third would otherwise see the book on all three turns or none. It is also
     * the answer to "did it actually get my PDF?" — a question the transcript
     * could not answer before, so the teacher had to guess.
     *
     * Names and keys only; the bytes stay in the file store.
     */
    files: { type: [{ _id: false, key: String, name: String, mime: String }], default: undefined },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

/*
 * A reference the teacher attached: a textbook page, a photo of a worksheet, a
 * syllabus. Stored with the document because the model needs it on EVERY turn —
 * "add three more like the ones on page 4" means nothing if page 4 was only visible
 * during the first request.
 */
const fileSchema = new Schema(
  {
    key: { type: String, required: true }, // content hash — the same page twice is one file
    ext: { type: String, default: "" },
    mime: { type: String, default: "" },
    name: { type: String, default: "" },
    bytes: { type: Number, default: 0 },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const lessonDocSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },

    title: { type: String, default: "" },
    topic: { type: String, default: "" },
    subject: { type: String, default: "" },
    grade: { type: String, default: "" },
    // Who it is written for — it changes the register the model writes in more than
    // any other single instruction.
    audience: { type: String, default: "" },

    blocks: { type: [blockSchema], default: undefined },
    messages: { type: [messageSchema], default: undefined },
    files: { type: [fileSchema], default: undefined },

    // The teacher's chosen export. Remembered so the button says the right thing
    // next time rather than asking again.
    format: { type: String, enum: ["pdf", "docx"], default: "pdf" },

    status: { type: String, enum: ["draft", "ready", "archived"], default: "draft" },
    // Draft-side CAS, same contract as LessonPlan: a write with a stale revision
    // gets 409 rather than silently overwriting another tab.
    revision: { type: Number, default: 0 },
    archivedAt: { type: Date, default: null },

    aiMeta: { type: Schema.Types.Mixed, default: undefined },
    schemaVersion: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    minimize: false,
    autoIndex: false,
    autoCreate: false,
    collection: "lesson_docs",
  }
);

module.exports = mongoose.model("LessonDoc", lessonDocSchema);
module.exports.BLOCK_KINDS = BLOCK_KINDS;
module.exports.blockSchema = blockSchema;
