/*
 * AUD-013 CR-057/CR-068 — migrate existing exam PDFs from the PUBLIC /uploads
 * path into PRIVATE random-key storage, RESUMABLY and byte-safely.
 *
 *   node migrations/2026-07-26-exam-pdf-private.js --dry-run [--db=<name>]
 *   node migrations/2026-07-26-exam-pdf-private.js --apply --db=<name> [--skip-ambiguous]
 *   node migrations/2026-07-26-exam-pdf-private.js --verify --db=<name>
 *   node migrations/2026-07-26-exam-pdf-private.js --rollback --db=<name> --batch=<id>   (--batch REQUIRED)
 *
 * Per-record STATE MACHINE with a durable journal collection
 * (`exampdfmigrationjournal`), so no crash can strand a file or lose bytes:
 *
 *   planned  → journal row written (batch, pdfId, oldPath, key)
 *   copied   → source copied to <key>.pdf, fsync'd, checksum+size verified
 *   committed→ pdfs row CAS-updated to the key (old file still present)
 *   done     → old source removed LAST
 *
 * At every phase at least one verified copy of the bytes exists. `--apply`
 * RESUMES every unfinished journal row (a journaled crash is never treated as an
 * ordinary "missing" file). `--verify` FAILS unless every in-scope row is
 * private with one matching, checksum-correct file and no unresolved
 * remote/missing/unsafe/duplicate/unfinished state. `--rollback` is batch-scoped
 * and CAS-safe and never overwrites a file changed after its journal entry.
 *
 * A test-only failpoint (EXAM_PDF_MIG_FAILPOINT = planned|copied|committed|done)
 * aborts immediately AFTER that phase to prove resume/verify/rollback converge.
 *
 * SAFETY (CR-043): native driver; throwaway db NAME / matching --db / --force.
 */
require("dotenv").config();
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { EXAM_PDF_DIR, PDF_STAGING_DIR, newKey, pathForKey, isValidKey } = require("../helper/examPdfStorage");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const modeFlags = ["--dry-run", "--apply", "--verify", "--rollback"].filter(has);
if (modeFlags.length > 1) { console.error(`\nREFUSED: contradictory modes ${modeFlags.join(" ")}.\n`); process.exit(2); }
const APPLY = has("--apply"), ROLLBACK = has("--rollback"), VERIFY = has("--verify"), DRY = !APPLY && !ROLLBACK && !VERIFY;
const FORCE = has("--force"), SKIP_AMBIGUOUS = has("--skip-ambiguous");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";
const batchArg = (argv.find((a) => a.startsWith("--batch=")) || "").split("=")[1] || "";
const UPLOADS_DIR = process.env.UPLOADS_DIR || PDF_STAGING_DIR;
const JOURNAL_COLL = "exampdfmigrationjournal";
const FAILPOINT = process.env.EXAM_PDF_MIG_FAILPOINT || "";
// CR-093: absolute legacy `/uploads/` `oldPath`s are accepted ONLY when their
// origin is EXPLICITLY approved — via `--legacy-origin=<origin>` (repeatable) or a
// comma-separated `LEGACY_UPLOADS_ORIGIN` env. A relative `/uploads/<basename>` is
// always allowed. Everything else (attacker/look-alike origins, credentials,
// alternate schemes, query/fragment, traversal, encoded separators) is rejected.
const LEGACY_ORIGINS = new Set(
  [
    ...argv.filter((a) => a.startsWith("--legacy-origin=")).map((a) => a.split("=")[1] || ""),
    ...(process.env.LEGACY_UPLOADS_ORIGIN || "").split(","),
  ].map((s) => s.trim()).filter(Boolean)
);

function dbNameFromUri(uri) { try { const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://")); return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || ""; } catch { return ""; } }
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(n);

function localFilename(p) {
  if (typeof p !== "string") return null;
  const i = p.indexOf("/uploads/");
  if (i < 0) return null;
  const name = p.slice(i + "/uploads/".length).split(/[?#]/)[0];
  return name || null;
}
const unsafeName = (n) => !n || n.includes("..") || n.includes("/") || n.includes("\\") || n.includes("\0");
const sha256File = async (abs) => { const b = await fsp.readFile(abs); return crypto.createHash("sha256").update(b).digest("hex"); };

async function copyFsync(src, dest) {
  const buf = await fsp.readFile(src);
  const fh = await fsp.open(dest, "w");
  try { await fh.writeFile(buf); await fh.sync(); } finally { await fh.close(); }
}

function tripwire(phase) {
  if (FAILPOINT && FAILPOINT === phase) {
    console.error(`FAILPOINT: aborting after phase "${phase}".`);
    process.exit(97);
  }
}

async function classify(pdfs) {
  const rows = await pdfs.find({}).toArray();
  const byFile = new Map();
  for (const r of rows) { const f = localFilename(r.path); if (f) byFile.set(f, (byFile.get(f) || 0) + 1); }
  const cats = { alreadyPrivate: [], local: [], remote: [], missing: [], unsafe: [], duplicate: [] };
  for (const r of rows) {
    if (isValidKey(r.key)) { cats.alreadyPrivate.push(r); continue; }
    const f = localFilename(r.path);
    if (!f) { cats.remote.push(r); continue; }          // non-uploads URL ⇒ remote
    if (unsafeName(f)) { cats.unsafe.push(r); continue; }
    if ((byFile.get(f) || 0) > 1) { cats.duplicate.push({ ...r, f }); continue; }
    if (fs.existsSync(path.join(UPLOADS_DIR, f))) cats.local.push({ ...r, f });
    else cats.missing.push(r);
  }
  return cats;
}

// Drive one record through the state machine, RESUMING from its journal phase.
async function migrateRecord(pdfs, journal, row, batchId) {
  const pdfId = row._id;
  let j = await journal.findOne({ _id: pdfId });
  const oldFile = path.join(UPLOADS_DIR, row.f);

  // planned: create the journal intent (key chosen once, persisted for resume).
  if (!j) {
    const key = newKey();
    j = { _id: pdfId, batchId, oldPath: row.path, filename: row.f, key, phase: "planned", updatedAt: new Date() };
    await journal.insertOne(j);
    tripwire("planned");
  }
  const priv = pathForKey(j.key);

  // copied: copy → fsync → verify checksum against the source.
  if (j.phase === "planned") {
    const srcSum = await sha256File(oldFile);
    const { size } = await fsp.stat(oldFile);
    await copyFsync(oldFile, priv);
    if ((await sha256File(priv)) !== srcSum) throw new Error(`checksum mismatch after copy for ${pdfId}`);
    await journal.updateOne({ _id: pdfId }, { $set: { phase: "copied", checksum: srcSum, size, updatedAt: new Date() } });
    j.phase = "copied"; j.checksum = srcSum; j.size = size;
    tripwire("copied");
  }

  // committed: verify the copy, then CAS the EXACT legacy row (old path + no key,
  // or already our key for idempotent resume) to the key, PERSISTING the
  // authoritative size + hash so --verify has a per-row checksum. A path/key that
  // changed under us matches nothing → surfaced as a conflict, never success.
  if (j.phase === "copied") {
    if (!fs.existsSync(priv) || (await sha256File(priv)) !== j.checksum) throw new Error(`private copy invalid for ${pdfId}`);
    // CR-080: also REMOVE the runtime public `path` (rollback data lives in the
    // journal `oldPath`) — a keyed row must NOT retain a public/remote path, or
    // strict verify treats it as an unresolved external location.
    const r = await pdfs.updateOne(
      { _id: pdfId, path: j.oldPath, $or: [{ key: { $exists: false } }, { key: null }, { key: j.key }] },
      { $set: { key: j.key, size: j.size, hash: j.checksum }, $unset: { path: "" } }
    );
    const after = await pdfs.findOne({ _id: pdfId }, { projection: { key: 1 } });
    if (r.matchedCount === 0 && after.key !== j.key) throw new Error(`commit CAS conflict for ${pdfId} (path/key changed under migration)`);
    if (after.key !== j.key) throw new Error(`commit failed for ${pdfId} (key=${after.key})`);
    // CR-083: BIND the migrated row to its referencing Exam (owner + examId +
    // state:attached) so the reverse invariant holds. Exactly one referencing
    // exam binds; zero/multiple are left unbound for --verify to BLOCK.
    const refs = await mongoose.connection.db.collection("exams").find({ pdf: pdfId }).project({ _id: 1, owner: 1 }).toArray();
    if (refs.length === 1) await pdfs.updateOne({ _id: pdfId, key: j.key }, { $set: { state: "attached", owner: refs[0].owner, examId: refs[0]._id } });
    await journal.updateOne({ _id: pdfId }, { $set: { phase: "committed", updatedAt: new Date() } });
    j.phase = "committed";
    tripwire("committed");
  }

  // done: remove the old source LAST. Only ENOENT (already gone) is an idempotent
  // success; ANY other unlink error keeps the row `committed` and fails the run so
  // it is retried — never silently advanced to done.
  if (j.phase === "committed") {
    try { await fsp.unlink(oldFile); }
    catch (e) { if (e.code !== "ENOENT") throw new Error(`source delete failed for ${pdfId}: ${e.code || e.message} (kept committed)`); }
    await journal.updateOne({ _id: pdfId }, { $set: { phase: "done", updatedAt: new Date() } });
    tripwire("done");
  }
}

// CR-093: validate that a journal `oldPath` is an APPROVED legacy `/uploads/`
// location whose DECODED basename EXACTLY equals `filename` — never an arbitrary
// (attacker-origin) string blindly written back to the DB row. Accepts ONLY:
//   - a relative `/uploads/<basename>` (no traversal, no subdir), or
//   - an absolute http(s) URL whose ORIGIN is in the approved `LEGACY_ORIGINS`,
//     with no embedded credentials.
// Rejects credentials, other/look-alike origins, non-http schemes, protocol-
// relative URLs, query/fragment, path traversal/normalization and encoded
// separator tricks (%2f, %5c, %2e). Exported + parameterized for a unit matrix.
function validLegacyOldPath(oldPath, filename, legacyOrigins = LEGACY_ORIGINS) {
  if (typeof oldPath !== "string" || !oldPath) return false;
  if (/[\s\\]/.test(oldPath)) return false;                    // whitespace / backslash
  if (/%2f|%5c|%2e/i.test(oldPath)) return false;              // encoded separators / dot
  let u;
  if (oldPath.startsWith("/")) {
    if (oldPath.startsWith("//")) return false;                // protocol-relative
    try { u = new URL(oldPath, "http://internal.invalid"); } catch { return false; }
    if (u.origin !== "http://internal.invalid") return false;  // a host means it was not relative
  } else {
    try { u = new URL(oldPath); } catch { return false; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (u.username || u.password) return false;                // no embedded credentials
    if (!legacyOrigins || !legacyOrigins.has(u.origin)) return false; // approved origin only
  }
  if (u.search || u.hash) return false;                        // no query/fragment ambiguity
  const prefix = "/uploads/";
  if (!u.pathname.startsWith(prefix)) return false;
  const rest = u.pathname.slice(prefix.length);
  if (!rest || rest.includes("/")) return false;               // no subdir / traversal
  let decoded;
  try { decoded = decodeURIComponent(rest); } catch { return false; }
  if (unsafeName(decoded)) return false;
  return decoded === filename;                                 // decoded basename == filename
}

// CR-084/CR-093: validate a journal entry's fields + CONTAINMENT + oldPath ORIGIN
// before any filesystem access or DB write-back. A corrupt/traversal/attacker-
// origin journal must never read/write outside the roots or persist a hostile URL.
function validJournalEntry(e) {
  if (!isValidKey(e.key)) return false;
  if (typeof e.filename !== "string" || unsafeName(e.filename) || path.basename(e.filename) !== e.filename) return false;
  if (!validLegacyOldPath(e.oldPath, e.filename)) return false;
  if (typeof e.checksum !== "string" || !/^[a-f0-9]{64}$/.test(e.checksum)) return false;
  if (!Number.isSafeInteger(e.size) || e.size < 0) return false;
  const dest = path.resolve(UPLOADS_DIR, e.filename);
  if (path.dirname(dest) !== path.resolve(UPLOADS_DIR)) return false; // containment
  const priv = pathForKey(e.key);
  if (!priv) return false;
  return true;
}

// CR-084/CR-089: restore the destination through a RUN-OWNED, UNPREDICTABLE temp
// in the same directory (same filesystem), then ATOMICALLY install it by HARD-LINK.
// `link()` fails with EEXIST if the destination already exists (POSIX + Win32), so a
// file created after any check can NEVER be overwritten — a true no-clobber install,
// not a TOCTOU check-then-rename. On EEXIST the existing bytes are VERIFIED (a
// concurrent worker that installed the SAME journaled bytes is success; anything
// else is a mismatch). The temp is unpredictable, so one worker never shares or
// deletes another worker's partial; we only ever remove OUR OWN temp.
async function restoreDest(dest, priv, e) {
  if (fs.existsSync(dest)) {
    const st = await fsp.stat(dest);
    if (st.size !== e.size || (await sha256File(dest)) !== e.checksum) return "refused_dest_mismatch";
    return "ok"; // already the journaled bytes
  }
  if (!priv || !fs.existsSync(priv)) return "refused_no_private_source";
  if ((await sha256File(priv)) !== e.checksum) return "refused_private_mismatch";
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  const tmp = `${dest}.${crypto.randomBytes(12).toString("hex")}.rbtmp`; // run-owned, unpredictable
  try {
    await copyFsync(priv, tmp);
    if ((await sha256File(tmp)) !== e.checksum) return "refused_restore_failed";
    // TEST seam: simulate a concurrent writer creating the destination at the final
    // install boundary (after our checks, right before link).
    if (process.env.EXAM_PDF_RB_PREEMPT_DEST && !fs.existsSync(dest)) {
      const bytes = process.env.EXAM_PDF_RB_PREEMPT_DEST === "match" ? await fsp.readFile(priv) : Buffer.from("DIFFERENT-BYTES");
      await fsp.writeFile(dest, bytes);
    }
    try {
      // TEST seam: inject an install-time fs error (EACCES/EBUSY) to prove retention.
      if (process.env.EXAM_PDF_RB_LINK_FAIL) { const err = new Error("injected link failure"); err.code = process.env.EXAM_PDF_RB_LINK_FAIL; throw err; }
      await fsp.link(tmp, dest); // atomic no-clobber install
      return "ok";
    } catch (err) {
      if (err.code === "EEXIST") {
        const st = await fsp.stat(dest); // a concurrent writer got there first — verify, never overwrite
        return (st.size === e.size && (await sha256File(dest)) === e.checksum) ? "ok" : "refused_dest_mismatch";
      }
      if (err.code === "EACCES" || err.code === "EBUSY" || err.code === "EPERM") return "refused_install_failed"; // retained + retryable
      throw err;
    }
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {}); // remove ONLY our own temp
  }
}

// CR-073/CR-080/CR-084: revert ONE record byte-safely, resumably, with PERSISTED
// named rollback phases (rbPhase: dest → cas → priv → done). Restore the
// destination (run-owned temp) → CAS the migration-owned key+path back (a CAS
// MISS is a conflict UNLESS the row EXACTLY equals the intended post-state) →
// delete the private copy → drop the journal only after a postcondition that
// REQUIRES the private source absent. Any conflict/fs error mutates nothing
// further and RETAINS the private copy + journal for retry.
async function rollbackRecord(pdfs, journal, e) {
  if (!validJournalEntry(e)) return "refused_corrupt_journal";
  const priv = pathForKey(e.key);
  const dest = path.join(UPLOADS_DIR, e.filename);
  const rbPhase = e.rbPhase || "start";

  // 1. Ensure the destination holds the journaled bytes (atomic, no overwrite).
  const dr = await restoreDest(dest, priv, e);
  if (dr !== "ok") return dr;
  if (rbPhase === "start") { await journal.updateOne({ _id: e._id }, { $set: { rbPhase: "dest" } }); e.rbPhase = "dest"; }
  tripwire("rb_dest");

  // 2. CAS the exact migration-owned key OFF and restore the runtime `path`. A CAS
  //    MISS is idempotent ONLY when the row is EXACTLY in the intended post-state
  //    (path===oldPath, no key/size/hash). A missing row or any rebound/rekeyed
  //    state is a CONFLICT — not silent success.
  if (e.rbPhase === "dest") {
    const r = await pdfs.updateOne({ _id: e._id, key: e.key }, { $unset: { key: "", size: "", hash: "" }, $set: { path: e.oldPath } });
    if (r.matchedCount === 0) {
      const row = await pdfs.findOne({ _id: e._id });
      const exactPostState = row && row.key == null && row.size == null && row.hash == null && row.path === e.oldPath;
      if (!exactPostState) return "cas_conflict";
    }
    await journal.updateOne({ _id: e._id }, { $set: { rbPhase: "cas" } }); e.rbPhase = "cas";
  }
  tripwire("rb_cas");

  // 3. Delete the private copy. CR-080: only ENOENT is idempotent; ANY other error
  //    RETAINS the private copy + journal for retry (never dropped mid-failure).
  if (e.rbPhase === "cas") {
    if (priv) {
      try { await fsp.unlink(priv); }
      catch (err) { if (err.code !== "ENOENT") return "refused_private_unlink_failed"; }
    }
    await journal.updateOne({ _id: e._id }, { $set: { rbPhase: "priv" } }); e.rbPhase = "priv";
  }
  tripwire("rb_priv");

  // 4. Postcondition: dest has the journaled bytes, the DB row no longer carries
  //    our key, AND the private source is ABSENT. Only then drop the journal.
  const finalRow = await pdfs.findOne({ _id: e._id }, { projection: { key: 1 } });
  if (!fs.existsSync(dest) || (await sha256File(dest)) !== e.checksum || (finalRow && finalRow.key === e.key) || (priv && fs.existsSync(priv))) return "postcondition_failed";
  await journal.deleteOne({ _id: e._id });
  return "reverted";
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.DATABASE_CLOUD || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;
  console.log(`\nAUD-013 exam-pdf-private migration — ${ROLLBACK ? "ROLLBACK" : APPLY ? "APPLY" : VERIFY ? "VERIFY" : "DRY RUN (read-only)"}`);
  console.log(`  database: ${dbName}`);
  // CR-074: EVERY safety refusal, in every mode, exits NONZERO — a "Refusing"
  // that returned 0 was indistinguishable from a successful verify in automation.
  if (!safe) { console.log(`\n  Target "${dbName}" not a throwaway NAME and no --db=${dbName}. Refusing.\n`); process.exit(3); }

  await mongoose.connect(uri);
  const pdfs = mongoose.connection.db.collection("pdfs");
  const journal = mongoose.connection.db.collection(JOURNAL_COLL);
  const cats = await classify(pdfs);
  const unfinished = await journal.countDocuments({ phase: { $ne: "done" } });
  console.log(`  census: alreadyPrivate=${cats.alreadyPrivate.length} local=${cats.local.length} remote=${cats.remote.length} missing=${cats.missing.length} unsafe=${cats.unsafe.length} duplicate=${cats.duplicate.length}; unfinished-journal=${unfinished}`);

  if (DRY) {
    if (cats.remote.length) console.log("  NOTE: remote rows must be resolved manually — --verify will BLOCK while any remain.");
    if (cats.unsafe.length || cats.duplicate.length) console.log("  NOTE: ambiguous rows present — --apply REFUSES unless --skip-ambiguous.");
    console.log("\nDRY RUN complete — READ ONLY.\n");
    await mongoose.disconnect(); return process.exit(0);
  }

  if (VERIFY) {
    // CR-074/CR-080: strict, NON-SAMPLING verification. Every keyed row is checked
    // against its authoritative size+hash; a keyed row that STILL carries any
    // public/remote `path` is INCOMPLETE (keyedWithPath). Every COMPLETED (`done`)
    // migration journal is validated against the exact row key/size/hash, the
    // private bytes, and the source-removal postcondition. Duplicate keys,
    // keyed-missing files, checksum/size mismatch, leftover sources, orphan private
    // files and unfinished journals all BLOCK.
    let keyedMissing = 0, checksumMismatch = 0, sizeMismatch = 0, dupKeys = 0, leftoverSource = 0, noAuthChecksum = 0, keyedWithPath = 0;
    const keySet = new Set();
    for (const r of cats.alreadyPrivate) {
      if (keySet.has(r.key)) dupKeys += 1; else keySet.add(r.key);
      if (typeof r.path === "string" && r.path) keyedWithPath += 1; // unresolved public/remote location
      const abs = pathForKey(r.key);
      if (!abs || !fs.existsSync(abs)) { keyedMissing += 1; continue; }
      if (typeof r.size !== "number" || typeof r.hash !== "string") { noAuthChecksum += 1; continue; }
      const st = await fsp.stat(abs);
      if (st.size !== r.size) sizeMismatch += 1;
      if ((await sha256File(abs)) !== r.hash) checksumMismatch += 1;
      const f = localFilename(r.path);
      if (f && !unsafeName(f) && fs.existsSync(path.join(UPLOADS_DIR, f))) leftoverSource += 1;
    }
    // CR-083/CR-088: STRICT terminal binding, checked in BOTH directions.
    //  (a) Exam side (AUTHORITATIVE): every Exam.pdf reference MUST resolve to a
    //      PRIVATE (keyed), state:"attached" row whose owner AND examId are PRESENT
    //      and equal to the referencing exam. A staged/claimed/attaching/deleting,
    //      unkeyed, missing, or owner/examId-absent/mismatched target BLOCKS. (This
    //      is the exact hole Codex reproduced: a `staged`, owner/examId-less keyed
    //      row referenced by one exam previously passed.)
    //  (b) Attached side: every state:"attached" keyed row MUST be referenced by
    //      EXACTLY ONE exam with matching owner + examId (no orphan / duplicate /
    //      cross-owner). A transient keyed row (staged/claimed/attaching) referenced
    //      by ZERO exams is a legitimate in-flight upload — not a binding blocker.
    const examsColl = mongoose.connection.db.collection("exams");
    let examRefUnbound = 0;
    for (const e of await examsColl.find({ pdf: { $ne: null } }).project({ _id: 1, owner: 1, pdf: 1 }).toArray()) {
      const row = await pdfs.findOne({ _id: e.pdf });
      const bound = !!(row && row.state === "attached" && isValidKey(row.key) &&
        row.owner && String(row.owner) === String(e.owner) &&
        row.examId && String(row.examId) === String(e._id));
      if (!bound) examRefUnbound += 1;
    }
    let unboundKeyed = 0, ownerMismatch = 0;
    for (const r of cats.alreadyPrivate) {
      if (r.state !== "attached") continue; // transient keyed rows are handled by the lifecycle
      const refs = await examsColl.find({ pdf: r._id }).project({ _id: 1, owner: 1 }).toArray();
      if (refs.length !== 1 || !r.owner || !r.examId) { unboundKeyed += 1; continue; }
      if (String(refs[0].owner) !== String(r.owner) || String(refs[0]._id) !== String(r.examId)) ownerMismatch += 1;
    }
    // Validate EVERY completed journal against its row + private bytes + source removal.
    let doneJournalBad = 0;
    for (const j of await journal.find({ phase: "done" }).toArray()) {
      const row = await pdfs.findOne({ _id: j._id }, { projection: { key: 1, size: 1, hash: 1, path: 1 } });
      const abs = j.key && pathForKey(j.key);
      const bytesOk = abs && fs.existsSync(abs) && (await sha256File(abs)) === j.checksum;
      const rowOk = row && row.key === j.key && row.size === j.size && row.hash === j.checksum && !row.path;
      const sourceGone = !fs.existsSync(path.join(UPLOADS_DIR, j.filename || "\0"));
      if (!bytesOk || !rowOk || !sourceGone) doneJournalBad += 1;
    }
    let orphanFiles = 0;
    try {
      for (const n of (await fsp.readdir(EXAM_PDF_DIR)).filter((x) => x.endsWith(".pdf"))) {
        if (!keySet.has(n.replace(/\.pdf$/, ""))) orphanFiles += 1;
      }
    } catch { /* dir absent on a fresh box */ }
    const blockers =
      cats.local.length + cats.remote.length + cats.missing.length + cats.unsafe.length + cats.duplicate.length +
      keyedMissing + checksumMismatch + sizeMismatch + dupKeys + leftoverSource + noAuthChecksum + keyedWithPath + doneJournalBad + orphanFiles + unfinished + examRefUnbound + unboundKeyed + ownerMismatch;
    const ok = blockers === 0;
    console.log(`\nVERIFY — local=${cats.local.length} remote=${cats.remote.length} missing=${cats.missing.length} unsafe=${cats.unsafe.length} duplicate=${cats.duplicate.length} keyed-missing=${keyedMissing} checksum-mismatch=${checksumMismatch} size-mismatch=${sizeMismatch} dup-keys=${dupKeys} leftover-source=${leftoverSource} no-checksum=${noAuthChecksum} keyed-with-path=${keyedWithPath} done-journal-bad=${doneJournalBad} orphan-files=${orphanFiles} exam-ref-unbound=${examRefUnbound} unbound-keyed=${unboundKeyed} owner-mismatch=${ownerMismatch} unfinished=${unfinished}; ok=${ok}.\n`);
    await mongoose.disconnect(); return process.exit(ok ? 0 : 1);
  }

  if (ROLLBACK) {
    // CR-073: rollback REQUIRES exactly one explicit non-empty --batch (a bare
    // rollback would select every journal row).
    if (!batchArg) { console.log(`\n  REFUSED: --rollback requires an explicit --batch=<id>.\n`); await mongoose.disconnect(); return process.exit(2); }
    const entries = await journal.find({ batchId: batchArg }).toArray();
    const tally = {};
    let reverted = 0;
    for (const e of entries) {
      const status = await rollbackRecord(pdfs, journal, e);
      tally[status] = (tally[status] || 0) + 1;
      if (status === "reverted") reverted += 1;
    }
    const failed = entries.length - reverted;
    console.log(`\nROLLBACK batch ${batchArg}: reverted ${reverted}/${entries.length}; ${JSON.stringify(tally)}.`);
    if (failed) console.log(`  ${failed} record(s) RETAINED for retry (private copy + journal preserved).`);
    console.log("");
    await mongoose.disconnect(); return process.exit(failed ? 1 : 0);
  }

  // ---- APPLY ----
  if ((cats.unsafe.length || cats.duplicate.length) && !SKIP_AMBIGUOUS) {
    console.log(`\n  REFUSED: ${cats.unsafe.length} unsafe + ${cats.duplicate.length} duplicate ambiguous row(s). Resolve them or pass --skip-ambiguous.\n`);
    await mongoose.disconnect(); return process.exit(4);
  }
  await fsp.mkdir(EXAM_PDF_DIR, { recursive: true });
  const batchId = batchArg || `${dbName}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;

  // 1) RESUME every unfinished journal row first (converge a prior crash).
  const resumeRows = await journal.find({ phase: { $ne: "done" } }).toArray();
  for (const e of resumeRows) {
    const row = await pdfs.findOne({ _id: e._id });
    await migrateRecord(pdfs, journal, { ...(row || {}), _id: e._id, f: e.filename, path: e.oldPath }, e.batchId || batchId);
  }
  // 2) Migrate fresh local rows.
  let started = 0;
  for (const r of cats.local) {
    if (await journal.findOne({ _id: r._id })) continue; // already journaled/resumed
    await migrateRecord(pdfs, journal, r, batchId);
    started += 1;
  }

  // 3) CR-088/CR-092: BACKFILL already-private rows (private BEFORE this migration)
  //    that a single exam references but that are not yet fully bound. The CAS pins
  //    the COMPLETE observed pre-state — key + exact state + exact (missing-or-
  //    matching) owner/examId — so a CONCURRENT rebind between the read and the CAS
  //    is never overwritten. `bound` counts ONLY this migration's winning update; a
  //    miss is re-read and accepted only if it reached the EXACT intended terminal
  //    state, otherwise it is a conflict that BLOCKS (nonzero apply).
  const examsColl = mongoose.connection.db.collection("exams");
  const eqOrAbsent = (v) => (v == null ? null : v); // {field:null} matches absent-or-null
  let bound = 0, backfillConflicts = 0;
  for (const r of cats.alreadyPrivate) {
    const refs = await examsColl.find({ pdf: r._id }).project({ _id: 1, owner: 1 }).toArray();
    if (refs.length !== 1) continue;
    const ex = refs[0];
    if ((r.owner && String(r.owner) !== String(ex.owner)) || (r.examId && String(r.examId) !== String(ex._id))) continue; // cross-binding → verify blocks
    if (r.state === "attached" && r.owner && r.examId) continue; // already fully bound

    // TEST seam (CR-092): mutate the row to a DIFFERENT binding AFTER the read but
    // BEFORE the CAS, proving a concurrent different binding is never overwritten.
    if (process.env.EXAM_PDF_MIG_BACKFILL_MUTATE) {
      const evil = new mongoose.Types.ObjectId();
      await pdfs.updateOne({ _id: r._id }, { $set: { state: "attached", owner: evil, examId: evil } });
    }

    const casFilter = {
      _id: r._id,
      key: r.key,
      state: r.state == null ? null : r.state,
      owner: eqOrAbsent(r.owner),
      examId: eqOrAbsent(r.examId),
    };
    const res = await pdfs.updateOne(casFilter, { $set: { state: "attached", owner: ex.owner, examId: ex._id } });
    if (res.matchedCount === 1) { bound += 1; continue; }
    // Miss ⇒ a concurrent actor changed the row. Accept ONLY if it is now the EXACT
    // intended terminal state; anything else is a conflict blocker (never overwritten).
    const nowRow = await pdfs.findOne({ _id: r._id });
    const isIntended = !!(nowRow && nowRow.state === "attached" && nowRow.key === r.key &&
      nowRow.owner && String(nowRow.owner) === String(ex.owner) &&
      nowRow.examId && String(nowRow.examId) === String(ex._id));
    if (!isIntended) backfillConflicts += 1;
  }

  const after = await classify(pdfs);
  const stillUnfinished = await journal.countDocuments({ phase: { $ne: "done" } });
  const ok = after.local.length === 0 && stillUnfinished === 0 && backfillConflicts === 0 &&
    (SKIP_AMBIGUOUS || (after.unsafe.length === 0 && after.duplicate.length === 0));
  console.log(`\nAPPLIED (batch ${batchId}) — migrated ${started} new + resumed ${resumeRows.length} + backfilled ${bound} already-private; backfill-conflicts=${backfillConflicts}; remaining local=${after.local.length}; unfinished=${stillUnfinished}; remote(manual)=${after.remote.length}; ok=${ok}.`);
  if (after.remote.length) console.log("  Remote rows still require manual resolution before --verify can pass.");
  await mongoose.disconnect();
  process.exit(ok ? 0 : 1);
}

// Run only when invoked directly; export pure validators for unit testing.
if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { validLegacyOldPath, validJournalEntry };
