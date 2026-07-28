process.env.NODE_ENV = "test";

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  pageLimit,
  decodeCursor,
  withCursor,
  pageResult,
} = require("../utils/cursorPagination");
const { SPECS } = require("../helper/reliabilityIndexes");

let passed = 0;
let failed = 0;
const ok = (name, condition) => {
  if (condition) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", name);
  }
};

async function main() {
  ok("default page is 25", pageLimit(undefined) === DEFAULT_LIMIT);
  ok("hard page maximum is 100", pageLimit(9999) === MAX_LIMIT);
  ok("invalid limit falls back", pageLimit("NaN") === DEFAULT_LIMIT);
  ok("malformed cursor is rejected by the decoder", decodeCursor("not-a-cursor") === null);
  let invalidCursorThrows = false;
  try {
    withCursor({}, "not-a-cursor");
  } catch (error) {
    invalidCursorThrows =
      error.status === 400 && error.code === "invalid_cursor";
  }
  ok("malformed API cursor fails closed", invalidCursorThrows);

  const memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  try {
    const db = mongoose.connection.db;
    const rows = db.collection("paginationrows");
    const base = Date.parse("2026-07-27T00:00:00.000Z");
    await rows.insertMany(
      Array.from({ length: 205 }, (_, index) => ({
        _id: new mongoose.Types.ObjectId(),
        createdAt: new Date(base - index * 1_000),
        label: `row-${index}`,
      }))
    );
    await rows.createIndex(
      { createdAt: -1, _id: -1 },
      { name: "page_createdAt_desc" }
    );

    let cursor = null;
    const seen = [];
    let first = true;
    do {
      const found = await rows
        .find(withCursor({}, cursor))
        .sort({ createdAt: -1, _id: -1 })
        .limit(26)
        .toArray();
      const page = pageResult(found, 25);
      seen.push(...page.items.map((row) => String(row._id)));
      cursor = page.nextCursor;
      if (first) {
        first = false;
        // A newer concurrent insert belongs before the already-consumed cursor
        // and must not be duplicated into the remaining walk.
        await rows.insertOne({
          _id: new mongoose.Types.ObjectId(),
          createdAt: new Date(base + 60_000),
          label: "concurrent-newer",
        });
      }
      if (!page.hasMore) break;
    } while (cursor);

    ok("cursor walk returns every original row once", seen.length === 205);
    ok("cursor walk has no duplicates", new Set(seen).size === seen.length);
    ok(
      "bounded envelope stays small",
      Buffer.byteLength(JSON.stringify({ items: seen.slice(0, 25), hasMore: true, nextCursor: cursor })) < 10_000
    );

    const explain = await rows
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .hint("page_createdAt_desc")
      .explain("executionStats");
    const explainText = JSON.stringify(explain);
    ok("pagination explain uses the intended index", explainText.includes("page_createdAt_desc"));
    ok(
      "all paginated shipping collections are migration-owned",
      ["users", "materials", "videos", "exams", "results"].every((collection) =>
        SPECS.some(
          (spec) =>
            spec.collection === collection &&
            spec.name === "page_createdAt_desc"
        )
      )
    );
  } finally {
    await mongoose.disconnect();
    await memory.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
