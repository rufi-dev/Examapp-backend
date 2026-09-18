/*
 * One size policy for every path that can grow a board.
 *
 * A board is a SINGLE MongoDB document and a document cannot exceed 16 MB. A
 * handwriting board grows ~4 MB per lesson, so this is a wall real teachers
 * reach, not a theoretical one. Measured against the live database: a 13.9 MB
 * document stored fine, a 17.5 MB one threw a RangeError out of the driver — a
 * 500 with nothing written, while the teacher kept drawing into a board that
 * could no longer save.
 *
 * Four paths can write a scene: the HTTP save, a live-session checkpoint, the
 * boot replay of a live journal, and recovery. Each of them measures the
 * candidate document through THIS module, so the limit cannot be enforced in one
 * place and missed in another — which is exactly what happened when only the
 * HTTP save checked (live teaching, the heaviest path, was unprotected).
 *
 * The limit sits below Mongo's hard cap: what we measure is the document as we
 * build it, and the server adds its own framing on top.
 */
const { BSON } = require("mongoose").mongo;

const HARD_CAP = 16 * 1024 * 1024; // MongoDB's limit on one document
const DEFAULT_LIMIT = 15 * 1024 * 1024; // ours, with a megabyte of headroom
const NEAR_RATIO = 0.75; // warn the teacher here, while there is still room

// Read per call so a test can narrow the wall without building a 15 MB payload.
function maxDocBytes() {
  const raw = Number(process.env.BOARD_MAX_DOC_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, HARD_CAP) : DEFAULT_LIMIT;
}

// BSON size of any value, as it would be stored inside a document.
function sizeOf(value) {
  if (value === null || value === undefined) return 0;
  // calculateObjectSize wants a document; wrap so elements/scenes/arrays work too.
  return BSON.calculateObjectSize({ v: value });
}

// "ok" below the warning line, "near" past it, "full" past the limit itself.
function stateOf(bytes) {
  const limit = maxDocBytes();
  if (bytes > limit) return "full";
  if (bytes > limit * NEAR_RATIO) return "near";
  return "ok";
}

const fits = (bytes) => bytes <= maxDocBytes();

/*
 * The typed failure every path speaks. The HTTP save turns it into a 413 with a
 * code the editor knows; the live paths turn it into a refusal the room is told
 * about. It is never a raw 500 and never a silent retry loop.
 */
const CODE = "board_too_large";

function tooLargeError(bytes) {
  const e = new Error("Board document would exceed the size limit");
  e.code = CODE;
  e.status = 413;
  e.bytes = bytes;
  e.limit = maxDocBytes();
  return e;
}

/*
 * Did the DATABASE reject a write for size? The last safety net: our own measure
 * is taken before the write, so a document that still arrives too large (a field
 * we did not account for, a driver difference) must fail as the same typed error
 * rather than as an anonymous RangeError. Covers the driver's serializer
 * (RangeError on its buffer) and the server's own BSONObjectTooLarge / 10334.
 */
function isOversizeError(e) {
  if (!e) return false;
  if (e.code === CODE) return true;
  if (e.code === 10334 || e.code === 17419 || e.codeName === "BSONObjectTooLarge") return true;
  const msg = String(e.message || "");
  if (e instanceof RangeError && /offset is out of|out of range|out of bounds/i.test(msg)) return true;
  return /bsonobj(ect)? size|object to insert too large|document is larger than|maximum bson/i.test(msg);
}

module.exports = { CODE, HARD_CAP, NEAR_RATIO, maxDocBytes, sizeOf, stateOf, fits, tooLargeError, isOversizeError };
