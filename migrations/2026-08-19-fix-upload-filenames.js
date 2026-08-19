/*
 * Repair mangled UTF-8 upload filenames on EXISTING assignment attachments and
 * student submissions. multer 1.x (busboy) decoded multipart filenames as latin1,
 * so an Azerbaijani name like "dərs 1 ev tapşırığı.pdf" was stored mojibaked as
 * "dÉrs 1 ev tapÅÄ±rÄ±ÄÄ±.pdf". This re-decodes the stored bytes back to UTF-8.
 *
 *   node migrations/2026-08-19-fix-upload-filenames.js --dry-run [--db=<name>]
 *   node migrations/2026-08-19-fix-upload-filenames.js --apply --db=<name>
 *
 * SAFETY: contacting a DB requires a throwaway NAME, a matching --db=<name>, or
 * --force; every refusal exits NONZERO before any connection. Native driver only.
 *
 * IDEMPOTENT: a mojibake name is entirely in the latin1 range (every code point
 * <= 0xFF). A name already carrying real Unicode (ə/ş/ğ/ı… are > 0xFF) is treated
 * as ALREADY CORRECT and left untouched — so re-running never double-decodes.
 * Plain ASCII names round-trip unchanged. If re-decoding would introduce the
 * replacement char (bytes that aren't valid UTF-8), the original is kept.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has("--apply");
const DRY = !APPLY;
const FORCE = has("--force");
const dbArg = (argv.find((a) => a.startsWith("--db=")) || "").split("=")[1] || "";

function dbNameFromUri(uri) {
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:\/\//, "https://").replace(/^mongodb:\/\//, "https://"));
    return decodeURIComponent(u.pathname.replace(/^\//, "")).split("/")[0] || "";
  } catch {
    return "";
  }
}
const isThrowaway = (n) => /(^|[_-])(test|tests|memory|scratch|throwaway|ci|e2e|ephemeral)($|[_-])/i.test(n);

// True only for a name that is safe to re-decode: entirely latin1-range (mojibake
// or ASCII). A name with any code point > 0xFF already holds real Unicode → skip.
function isLatin1Range(name) {
  for (const ch of String(name)) if (ch.codePointAt(0) > 0xff) return false;
  return true;
}
function decodeName(name) {
  const raw = String(name || "");
  if (!raw || !isLatin1Range(raw)) return raw;
  const utf8 = Buffer.from(raw, "latin1").toString("utf8");
  if (utf8.includes("�") && !raw.includes("�")) return raw; // not UTF-8 bytes
  return utf8;
}

// Fix the `field` array's `originalName` on every doc in `coll`. Returns
// { scanned, changedDocs, changedFiles, samples }.
async function fixCollection(coll, field) {
  const cursor = coll.find({ [field]: { $exists: true, $ne: [] } }, { projection: { [field]: 1 } });
  let scanned = 0, changedDocs = 0, changedFiles = 0;
  const samples = [];
  for await (const doc of cursor) {
    scanned += 1;
    const arr = Array.isArray(doc[field]) ? doc[field] : [];
    let touched = false;
    const next = arr.map((f) => {
      const cur = f && f.originalName;
      const fixed = decodeName(cur);
      if (fixed !== cur) {
        touched = true;
        changedFiles += 1;
        if (samples.length < 8) samples.push({ from: cur, to: fixed });
        return { ...f, originalName: fixed };
      }
      return f;
    });
    if (touched) {
      changedDocs += 1;
      if (APPLY) await coll.updateOne({ _id: doc._id }, { $set: { [field]: next } });
    }
  }
  return { scanned, changedDocs, changedFiles, samples };
}

async function main() {
  const uri = process.env.MONGO_URI || "";
  if (!uri) { console.error("No MONGO_URI configured."); process.exit(2); }
  const dbName = dbNameFromUri(uri);
  if (!dbName) { console.log("Could not parse a database NAME; refusing to contact any DB."); process.exit(3); }
  const safe = isThrowaway(dbName) || (dbArg && dbArg === dbName) || FORCE;
  console.log(`\nfix-upload-filenames — ${APPLY ? "APPLY" : "DRY RUN (read-only)"}`);
  console.log(`  database: ${dbName}`);
  if (!safe) { console.log(`\n  Target "${dbName}" not a throwaway NAME and no --db=${dbName}. Refusing.\n`); process.exit(3); }

  await mongoose.connect(uri);
  const assignments = mongoose.connection.db.collection("assignments");
  const submissions = mongoose.connection.db.collection("submissions");

  const a = await fixCollection(assignments, "attachments");
  const s = await fixCollection(submissions, "files");

  const allSamples = [...a.samples, ...s.samples].slice(0, 12);
  if (allSamples.length) {
    console.log("\n  examples:");
    for (const ex of allSamples) console.log(`    "${ex.from}"\n      -> "${ex.to}"`);
  }
  console.log(
    `\n  assignments: scanned ${a.scanned}, docs changed ${a.changedDocs}, files fixed ${a.changedFiles}`
  );
  console.log(
    `  submissions: scanned ${s.scanned}, docs changed ${s.changedDocs}, files fixed ${s.changedFiles}`
  );
  console.log(APPLY ? "\nAPPLIED.\n" : "\nDRY RUN complete — READ ONLY. Re-run with --apply --db=<name> to write.\n");
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
