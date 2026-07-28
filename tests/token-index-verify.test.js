/*
 * AUD-008 CR-052 — the startup token-index VERIFIER confirms exact shapes and
 * never creates anything. Covers absent collection, un-indexed collection, fully
 * built, a missing index, and a wrong-shape (unique flag) index.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Token = require("../models/tokenModel");
const { verifyTokenIndexes, assertTokenIndexes } = require("../helper/tokenIndexes");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const oid = () => new mongoose.Types.ObjectId();

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const db = mongoose.connection.db;

  // ── absent collection ──
  let r = await verifyTokenIndexes(db);
  ok("absent collection → not ok + collectionMissing", r.ok === false && r.collectionMissing === true);
  ok("verify did NOT create the collection", (await db.listCollections({ name: "tokens" }).toArray()).length === 0);

  // ── collection exists but no AUD-008 indexes ──
  await Token.collection.insertOne({ userId: oid(), rToken: "r1", createdAt: new Date(), expiresAt: new Date(Date.now() + 3600e3) });
  r = await verifyTokenIndexes(db);
  ok("un-indexed collection → not ok, all 5 missing", r.ok === false && r.missing.length === 5);

  // ── fully built (schema declares them; autoIndex:false, so build explicitly) ──
  await Token.createIndexes();
  r = await verifyTokenIndexes(db);
  ok("after createIndexes → ok", r.ok === true && r.missing.length === 0 && r.mismatched.length === 0);
  let threw = false; try { await assertTokenIndexes(db); } catch { threw = true; }
  ok("assertTokenIndexes does NOT throw when built", threw === false);

  // ── a missing index ──
  await Token.collection.dropIndex("aud008_userId");
  r = await verifyTokenIndexes(db);
  ok("dropping one index → not ok, reported missing", r.ok === false && r.missing.includes("aud008_userId"));
  threw = false; try { await assertTokenIndexes(db); } catch (e) { threw = /migrations\/2026-07-26-token-indexes/.test(e.message); }
  ok("assertTokenIndexes throws with a migration instruction", threw === true);
  await Token.collection.createIndex({ userId: 1 }, { name: "aud008_userId" }); // restore

  // ── a wrong-shape index (unique flag differs) ──
  await Token.collection.dropIndex("aud008_uniq_rToken");
  await Token.collection.createIndex({ rToken: 1 }, { name: "aud008_uniq_rToken" }); // NOT unique + no partial
  r = await verifyTokenIndexes(db);
  ok("wrong-shape index → mismatched (unique/partial)", r.ok === false && r.mismatched.some((m) => m.name === "aud008_uniq_rToken"));

  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
