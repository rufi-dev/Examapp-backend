/*
 * ONE size policy for every path that can grow a board.
 *
 * A board is a single MongoDB document capped at 16 MB, and a handwriting board
 * grows ~4 MB per lesson. The first guard checked only the HTTP save — which the
 * editor deliberately does NOT use during a live lesson, so the heaviest writer
 * on the platform was the one path with no limit at all. These tests hold the
 * policy to being shared: the same measure, the same typed failure, and the same
 * rule that growth is refused while erasing is always allowed.
 *
 * Runs against a real MongoMemoryReplSet where a write is involved, because the
 * point is what MongoDB does, not what a mock says it does.
 */
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.NODE_ENV = "test";
process.env.BOARD_FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "boardsize-"));

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

const boardSize = require("../helper/boardSize");

async function main() {
  console.log("board size — the shared policy");
  ok("the limit sits under MongoDB's hard 16 MB cap", boardSize.maxDocBytes() < boardSize.HARD_CAP);
  /*
   * Configuration may only NARROW the wall. The live path's size arithmetic is
   * incremental (a document base plus per-element sizes), and the margin under
   * Mongo's cap is what absorbs that approximation — so a config value must not
   * be able to spend it, even by asking for the cap exactly.
   */
  ok("a config value may narrow the limit", (() => {
    process.env.BOARD_MAX_DOC_BYTES = "1000";
    const narrow = boardSize.maxDocBytes();
    delete process.env.BOARD_MAX_DOC_BYTES;
    return narrow === 1000;
  })());

  /*
   * The limit is a SUPPORTED setting (tunable downward without a deploy), so it
   * must say which value is in force and why — a configured value that was
   * silently ignored is indistinguishable from a bug on the day it matters.
   */
  const withEnv = (v, fn) => {
    if (v === null) delete process.env.BOARD_MAX_DOC_BYTES;
    else process.env.BOARD_MAX_DOC_BYTES = v;
    const out = fn();
    delete process.env.BOARD_MAX_DOC_BYTES;
    return out;
  };
  ok("unset -> the default, reported as the default", withEnv(null, () => {
    const c = boardSize.limitConfig();
    return c.source === "default" && c.value === boardSize.DEFAULT_LIMIT && c.raw === null;
  }));
  ok("a lower value -> accepted, reported as configured", withEnv("1048576", () => {
    const c = boardSize.limitConfig();
    return c.source === "configured" && c.value === 1048576;
  }));
  ok("a higher value -> clamped, and SAYS it was clamped", withEnv("99999999", () => {
    const c = boardSize.limitConfig();
    return c.source === "clamped" && c.value === boardSize.DEFAULT_LIMIT && /can be lowered, never raised/.test(boardSize.describeLimit());
  }));
  ok("nonsense -> the default, and SAYS it was ignored", withEnv("abc", () => {
    const c = boardSize.limitConfig();
    return c.source === "invalid" && c.value === boardSize.DEFAULT_LIMIT && /not a positive number/.test(boardSize.describeLimit());
  }));
  ok("an empty value is not a configuration at all", withEnv("", () => boardSize.limitConfig().source === "default"));
  ok("the boot line names the megabytes actually in force", withEnv("2097152", () => /2\.0 MB/.test(boardSize.describeLimit())));
  ok("but can never widen it — the safety margin survives any configuration", (() => {
    const results = [];
    for (const v of [String(64 * 1024 * 1024), String(boardSize.HARD_CAP), String(boardSize.HARD_CAP - 1)]) {
      process.env.BOARD_MAX_DOC_BYTES = v;
      results.push(boardSize.maxDocBytes());
    }
    delete process.env.BOARD_MAX_DOC_BYTES;
    return results.every((r) => r === 15 * 1024 * 1024) && boardSize.HARD_CAP - 15 * 1024 * 1024 === 1024 * 1024;
  })());
  ok("a nonsense value falls back to the safe default", (() => {
    const out = [];
    for (const v of ["0", "-5", "abc", ""]) {
      process.env.BOARD_MAX_DOC_BYTES = v;
      out.push(boardSize.maxDocBytes());
    }
    delete process.env.BOARD_MAX_DOC_BYTES;
    return out.every((r) => r === 15 * 1024 * 1024);
  })());
  ok("it measures BSON, not JavaScript object identity", boardSize.sizeOf({ a: "x".repeat(1000) }) > 1000);
  ok("a scene of many elements measures larger than one", boardSize.sizeOf([{ id: "a" }, { id: "b" }]) > boardSize.sizeOf([{ id: "a" }]));

  process.env.BOARD_MAX_DOC_BYTES = "1000";
  ok("states: ok → near (75%) → full (over)", boardSize.stateOf(100) === "ok" && boardSize.stateOf(800) === "near" && boardSize.stateOf(1001) === "full");
  ok("`fits` is the limit itself, inclusive", boardSize.fits(1000) && !boardSize.fits(1001));
  delete process.env.BOARD_MAX_DOC_BYTES;

  console.log("\nthe typed failure every path speaks");
  const e = boardSize.tooLargeError(99);
  ok("it carries a code, an HTTP status and the numbers", e.code === "board_too_large" && e.status === 413 && e.bytes === 99 && e.limit > 0);
  ok("the driver's serializer RangeError is recognised", boardSize.isOversizeError(new RangeError('The value of "offset" is out of range. It must be >= 0 && <= 17825792. Received 17825793')));
  ok("...and its other wording", boardSize.isOversizeError(new RangeError("offset is out of bounds")));
  ok("the server's BSONObjectTooLarge is recognised", boardSize.isOversizeError(Object.assign(new Error("x"), { code: 10334 })) && boardSize.isOversizeError(Object.assign(new Error("x"), { codeName: "BSONObjectTooLarge" })));
  ok("a resize message from the server is recognised", boardSize.isOversizeError(new Error("object to insert too large")));
  ok("an unrelated error is NOT swallowed as a size problem", !boardSize.isOversizeError(new Error("connection reset")) && !boardSize.isOversizeError(new RangeError("Invalid array length")));

  console.log("\nthe model write turns a database size rejection into that same failure");
  const { MongoMemoryReplSet } = require("mongodb-memory-server");
  const mongoose = require("mongoose");
  const mem = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mem.getUri(), { dbName: "boardsize" });
  const Board = require("../models/boardModel");
  const owner = new mongoose.Types.ObjectId();
  const board = await Board.create({ owner, title: "T", pages: [{ name: "p", scene: null }], revision: 0 });

  // A document the driver cannot serialize: past its 17 MB buffer.
  const huge = Array.from({ length: 30 }, (_, i) => ({ id: `e${i}`, blob: "x".repeat(700 * 1024) }));
  let thrown = null;
  try {
    await Board.writeScene(
      { _id: String(board._id), revision: 0 },
      { $set: { pages: [{ _id: new mongoose.Types.ObjectId(), name: "p", scene: { elements: huge } }] }, $inc: { revision: 1 } },
      { revision: 1 }
    );
  } catch (err) {
    thrown = err;
  }
  ok("an over-size write throws the typed failure, not a raw RangeError", thrown && thrown.code === "board_too_large", thrown ? `${thrown.name}: ${thrown.message}` : "nothing thrown");
  const after = await Board.findById(board._id).lean();
  ok("and the board keeps its last good state", after.revision === 0 && after.pages.length === 1);

  const good = await Board.writeScene(
    { _id: String(board._id), revision: 0 },
    { $set: { pages: [{ _id: new mongoose.Types.ObjectId(), name: "p", scene: { elements: [{ id: "a", type: "freedraw" }] } }] }, $inc: { revision: 1 } },
    { revision: 1 }
  );
  ok("a write that fits still goes through", good && good.revision === 1);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(2);
});
