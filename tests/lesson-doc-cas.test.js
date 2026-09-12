/*
 * Lesson Studio — the write contract, against a real Mongo.
 *
 * The audit's LS-002 is the finding that everything else stands on: the document
 * was read, mutated in memory, and written back with `doc.save()` on thirteen
 * paths, with a revision check on exactly one of them — and that one optional.
 * Between the read and the save there is a window, and in that window a second tab
 * (or an AI turn that started 40 seconds ago) writes back the copy it read at the
 * beginning. Whoever saves last wins, silently.
 *
 * These tests race two real writers against a real database, because that is the
 * only thing that proves a compare-and-set. A source-text assertion that the words
 * "doc_conflict" appear somewhere proves nothing about what happens when two
 * writes arrive at once.
 */
const assert = require("assert");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

(async () => {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "lessondoc-cas" });

  const LessonDoc = require("../models/lessonDocModel");
  const User = require("../models/userModel");
  const svc = require("../services/lessonDocService");

  const owner = new mongoose.Types.ObjectId();
  const stranger = new mongoose.Types.ObjectId();

  const fresh = async (over = {}) =>
    LessonDoc.create({ owner, title: "t", blocks: [{ id: "a", kind: "text", text: "one" }], ...over });

  console.log("\n1. A revision the caller must actually hold:");
  {
    const doc = await fresh();
    const refused = async (rev) => {
      try {
        await svc.commit(doc._id, owner, { title: "x" }, rev);
        return null;
      } catch (e) {
        return e.code;
      }
    };
    // A blind write is how one tab silently discards another's, so it is refused
    // outright rather than treated as "whatever is current".
    ok("a missing revision is refused", (await refused(undefined)) === "revision_required");
    ok("an empty revision is refused", (await refused("")) === "revision_required");
    ok("a negative revision is refused", (await refused(-1)) === "bad_revision");
    ok("a fractional revision is refused", (await refused(1.5)) === "bad_revision");
    ok("a non-numeric revision is refused", (await refused("soon")) === "bad_revision");
    ok("an unsafe integer is refused", (await refused(Number.MAX_SAFE_INTEGER + 2)) === "bad_revision");
    ok("nothing was written by any of them", (await LessonDoc.findById(doc._id)).title === "t");
  }

  console.log("\n2. Two writers, one winner (the finding itself):");
  {
    const doc = await fresh();
    const base = doc.revision;

    // Two tabs, both holding revision 0, both saving. Before the CAS this was the
    // silent-overwrite: both succeeded and the second erased the first.
    const results = await Promise.allSettled([
      svc.commit(doc._id, owner, { title: "from tab A" }, base),
      svc.commit(doc._id, owner, { title: "from tab B" }, base),
    ]);
    const wins = results.filter((r) => r.status === "fulfilled");
    const losses = results.filter((r) => r.status === "rejected");

    ok("exactly one write wins", wins.length === 1, `${wins.length} won`);
    ok("the other is told, not ignored", losses.length === 1 && losses[0].reason.code === "doc_conflict");
    ok("the loser gets a 409", losses[0].reason.status === 409);

    const after = await LessonDoc.findById(doc._id);
    ok("the winner's content is intact", after.title === wins[0].value.title);
    ok("the revision advanced exactly once", after.revision === base + 1, `${base} -> ${after.revision}`);
  }

  console.log("\n3. Ten writers at once:");
  {
    const doc = await fresh();
    const base = doc.revision;
    const all = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => svc.commit(doc._id, owner, { title: `w${i}` }, base))
    );
    const won = all.filter((r) => r.status === "fulfilled").length;
    ok("still exactly one winner under real concurrency", won === 1, `${won} won`);
    ok("and the revision moved by exactly one", (await LessonDoc.findById(doc._id)).revision === base + 1);
    ok("every loser got a conflict", all.filter((r) => r.status === "rejected").every((r) => r.reason.code === "doc_conflict"));
  }

  console.log("\n4. A conflict is never confused with a deletion:");
  {
    const doc = await fresh();
    await LessonDoc.deleteOne({ _id: doc._id });
    let code = null;
    try {
      await svc.commit(doc._id, owner, { title: "x" }, 0);
    } catch (e) {
      code = e.code;
    }
    // Telling a teacher to "refresh — someone else changed it" about a document
    // that no longer exists sends them to look for something that is not there.
    ok("a deleted document says missing, not conflict", code === "doc_missing");

    const other = await fresh();
    let strangerCode = null;
    try {
      await svc.commit(other._id, stranger, { title: "x" }, 0);
    } catch (e) {
      strangerCode = e.code;
    }
    ok("someone else's document is missing too, not a conflict", strangerCode === "doc_missing");
    ok("and it is untouched", (await LessonDoc.findById(other._id)).title === "t");
  }

  console.log("\n5. revision 0 matches a document that has never been written:");
  {
    // Documents created before the field existed carry no `revision` at all, and
    // `{ revision: 0 }` would not find them.
    const legacy = await fresh();
    await LessonDoc.collection.updateOne({ _id: legacy._id }, { $unset: { revision: "" } });
    const saved = await svc.commit(legacy._id, owner, { title: "migrated" }, 0);
    ok("a document with no revision field still commits at 0", saved.title === "migrated");
    ok("and gains a real revision", saved.revision === 1);
  }

  console.log("\n6. A message is appended, never overwritten:");
  {
    const doc = await fresh();
    // The turn reads the document, then the teacher's message is pushed, then the
    // turn commits. If the commit SET the array from its stale copy, the message
    // written in between would vanish.
    const stale = await LessonDoc.findById(doc._id);
    await svc.appendMessages(doc._id, owner, { role: "user", text: "salam", at: new Date() });
    await svc.commit(doc._id, owner, { title: "after" }, stale.revision, {
      push: { messages: { role: "assistant", text: "hazırdır", at: new Date() } },
    });

    const after = await LessonDoc.findById(doc._id);
    ok("both messages survive", after.messages.length === 2, JSON.stringify(after.messages.map((m) => m.role)));
    ok("in order", after.messages[0].role === "user" && after.messages[1].role === "assistant");
    ok("and the content committed with them", after.title === "after");
  }

  console.log("\n7. Appending a message does not invalidate open tabs:");
  {
    const doc = await fresh();
    const before = doc.revision;
    await svc.appendMessages(doc._id, owner, { role: "assistant", text: "Alınmadı", action: "failed", at: new Date() });
    const after = await LessonDoc.findById(doc._id);
    // A failure note is not document content. Bumping the revision for it would
    // conflict every open tab over a turn that changed nothing — and a failure
    // note written DURING a conflict would itself conflict.
    ok("the revision is unchanged", after.revision === before);
    ok("but the note is there", after.messages.length === 1);
  }

  console.log("\n8. The document quota is claimed, not observed:");
  {
    const quotaOwner = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: quotaOwner, name: "q", email: "q@e.test", role: "teacher" });

    // Ten simultaneous creates against a limit of 3. Count-then-create let all ten
    // read the same number and all decide there was room.
    const tries = await Promise.allSettled(
      Array.from({ length: 10 }, () => svc.reserveDocSlot(User, quotaOwner, 3))
    );
    const granted = tries.filter((r) => r.status === "fulfilled").length;
    ok("exactly the limit is granted, never more", granted === 3, `${granted} granted`);
    ok("the rest are refused with a reason", tries.filter((r) => r.status === "rejected").every((r) => r.reason.code === "too_many_docs"));
    ok("the counter equals what was granted", (await User.findById(quotaOwner)).lessonDocCount === 3);

    // A create that fails after claiming must hand the slot back.
    await svc.releaseDocSlot(User, quotaOwner);
    ok("releasing returns a slot", (await User.findById(quotaOwner)).lessonDocCount === 2);
    await svc.reserveDocSlot(User, quotaOwner, 3);
    ok("and the freed slot can be claimed again", (await User.findById(quotaOwner)).lessonDocCount === 3);
  }

  console.log("\n9. The counter starts from the truth, not from zero:");
  {
    const existing = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: existing, name: "e", email: "e@e.test", role: "teacher" });
    await LessonDoc.create({ owner: existing, title: "a" });
    await LessonDoc.create({ owner: existing, title: "b" });

    // An account that already holds documents must not be handed a fresh
    // allowance the first time the counter is used.
    await svc.reserveDocSlot(User, existing, 5);
    ok("the seed counts what is really there", (await User.findById(existing)).lessonDocCount === 3);

    // Never below zero: a counter under the truth hands out slots that do not exist.
    const empty = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: empty, name: "z", email: "z@e.test", role: "teacher", lessonDocCount: 0 });
    await svc.releaseDocSlot(User, empty);
    ok("releasing below zero is refused", (await User.findById(empty)).lessonDocCount === 0);
  }

  console.log("\n10. The counter heals when it drifts shut (LS-R3-017):");
  {
    /*
     * The counter is a projection of how many materials exist, and a projection
     * drifts — always upward, because a claim happens before the create and a
     * release after the delete, so any failure between them leaves a phantom.
     * Left alone, a teacher who owns nothing is eventually told they own two
     * hundred. A refused claim now recounts from the documents themselves.
     */
    const drifted = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: drifted, name: "d", email: "d@e.test", role: "teacher", lessonDocCount: 999 });
    await svc.reserveDocSlot(User, drifted, 3);
    ok("a claim on a drifted counter succeeds after a recount", (await User.findById(drifted)).lessonDocCount === 1);

    // And a genuinely full account is still refused: the counter and the
    // documents agree, so there is nothing to heal.
    const full = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: full, name: "f", email: "f@e.test", role: "teacher", lessonDocCount: 3 });
    for (let i = 0; i < 3; i += 1) await LessonDoc.create({ owner: full, title: `t${i}`, blocks: [] });
    let refused = false;
    try {
      await svc.reserveDocSlot(User, full, 3);
    } catch (e) {
      refused = e.code === "too_many_docs";
    }
    ok("a full account is still refused after the recount", refused);

    // Drift within in-flight range is NOT healed — that is a reservation whose
    // document has not been created yet, not a phantom. Counter 4, documents
    // 0, limit 3: refused, and the counter is left alone.
    const inflight = new mongoose.Types.ObjectId();
    await User.collection.insertOne({ _id: inflight, name: "i", email: "i@e.test", role: "teacher", lessonDocCount: 4 });
    let held = false;
    try {
      await svc.reserveDocSlot(User, inflight, 3);
    } catch (e) {
      held = e.code === "too_many_docs";
    }
    ok("small drift is treated as in-flight work and refused", held && (await User.findById(inflight)).lessonDocCount === 4);
  }

  console.log("\n11. The transcript is bounded (LS-R3-015):");
  {
    const d = await fresh();
    const many = Array.from({ length: svc.MAX_MESSAGES + 50 }, (_, i) => ({ role: "user", text: `m${i}`, at: new Date() }));
    await svc.appendMessages(d._id, owner, many);
    const after = await LessonDoc.findById(d._id).lean();
    ok("appending past the cap keeps exactly the cap", after.messages.length === svc.MAX_MESSAGES);
    ok("and keeps the NEWEST", after.messages[after.messages.length - 1].text === `m${svc.MAX_MESSAGES + 49}`);

    // The commit's own push rides the same cap, so no path can grow past it.
    const c = await svc.commit(d._id, owner, { title: "x" }, after.revision, {
      push: { messages: { role: "assistant", text: "last", at: new Date() } },
    });
    ok("a commit's message rides the same cap", c.messages.length === svc.MAX_MESSAGES && c.messages[c.messages.length - 1].text === "last");
  }

  await mongoose.disconnect();
  await mem.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  assert.strictEqual(failed, 0, `${failed} lesson-doc CAS assertions failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
