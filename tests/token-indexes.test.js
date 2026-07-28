/*
 * AUD-008 — the tokens collection has a TTL index on expiresAt and partial-UNIQUE
 * lookup indexes on rToken/vToken/lToken (unique only over non-empty values, since
 * a row carries exactly one). Proven against in-memory Mongo via the schema's own
 * indexes, plus a duplicate-insert rejection and the empty-value non-collision.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Token = require("../models/tokenModel");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const oid = () => new mongoose.Types.ObjectId();

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  await Token.createIndexes();

  const idx = await Token.collection.indexes();
  const byName = Object.fromEntries(idx.map((i) => [i.name, i]));

  const ttl = idx.find((i) => i.key && i.key.expiresAt === 1);
  ok("TTL index on expiresAt exists with expireAfterSeconds:0", !!ttl && ttl.expireAfterSeconds === 0);

  const uniq = (name, field) => {
    const i = byName[name];
    return i && i.unique === true && i.partialFilterExpression && i.partialFilterExpression[field];
  };
  ok("partial-unique index on rToken", !!uniq("aud008_uniq_rToken", "rToken"));
  ok("partial-unique index on vToken", !!uniq("aud008_uniq_vToken", "vToken"));
  ok("partial-unique index on lToken", !!uniq("aud008_uniq_lToken", "lToken"));
  ok("plain index on userId", idx.some((i) => i.name === "aud008_userId"));

  // Two DIFFERENT non-empty rToken values coexist.
  await Token.create({ userId: oid(), rToken: "hashA", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  await Token.create({ userId: oid(), rToken: "hashB", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  ok("two distinct non-empty rToken rows coexist", (await Token.countDocuments({ rToken: { $in: ["hashA", "hashB"] } })) === 2);

  // A DUPLICATE non-empty rToken is rejected by the unique index.
  let dupRejected = false;
  try {
    await Token.create({ userId: oid(), rToken: "hashA", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  } catch (e) { dupRejected = e && (e.code === 11000 || /duplicate key/i.test(e.message)); }
  ok("a duplicate non-empty rToken is rejected (unique)", dupRejected);

  // Many rows with EMPTY rToken (e.g. login-code / verify tokens) do NOT collide,
  // because the unique index is partial (non-empty only).
  await Token.create({ userId: oid(), lToken: "codeX", rToken: "", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  await Token.create({ userId: oid(), vToken: "verY", rToken: "", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  ok("empty rToken values do NOT collide (partial index)", (await Token.countDocuments({ rToken: "" })) === 2);

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
