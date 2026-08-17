/*
 * Durable write-ahead journal for live whiteboard sessions. An accepted (acked)
 * drawing is written here — atomically, with fsync — BEFORE it is durably in
 * Mongo, so a hard kill can't lose it: on boot the hub replays any journal whose
 * board revision Mongo has not yet advanced past, then deletes it only once Mongo
 * has proven (or superseded) it. One file per board.
 *
 * File format: { v:1, sha256, payload } where `payload` is the JSON string of the
 * entry and `sha256` is its checksum (corruption detection). The payload holds
 * { boardId, pageId, liveSessionId, acceptedRevision, boardRevision, scene }.
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

// Default lives under the container WORKDIR (/app) and is backed by a persistent
// Docker volume so it survives container recreation / hard kills.
const JOURNAL_DIR = process.env.LIVE_JOURNAL_DIR || path.join(process.cwd(), "live-journal");

try {
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
} catch {
  /* created lazily on first write */
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeId = (id) => String(id).replace(/[^a-fA-F0-9]/g, "");
const fileFor = (boardId) => path.join(JOURNAL_DIR, `${safeId(boardId)}.json`);

// fsync the directory so an atomic rename is itself durable (POSIX).
async function syncDir() {
  let dh;
  try {
    dh = await fsp.open(JOURNAL_DIR, "r");
    await dh.sync();
  } catch {
    /* not fatal (e.g. non-POSIX) */
  } finally {
    if (dh) await dh.close().catch(() => {});
  }
}

// Atomic + durable: write temp -> fsync file -> rename -> fsync dir.
async function writeEntry(entry) {
  try {
    fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  } catch {
    /* exists */
  }
  const payload = JSON.stringify(entry);
  const doc = JSON.stringify({ v: 1, sha256: sha256(payload), payload });
  const target = fileFor(entry.boardId);
  const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  let fh;
  try {
    fh = await fsp.open(tmp, "w");
    await fh.writeFile(doc);
    await fh.sync(); // fsync the bytes
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
  await fsp.rename(tmp, target); // atomic replace
  await syncDir();
}

async function deleteEntry(boardId) {
  try {
    await fsp.unlink(fileFor(boardId));
    await syncDir();
  } catch {
    /* already gone */
  }
}

// Read every valid entry. A file that fails checksum / parse is quarantined
// (renamed .corrupt) and skipped — never applied.
async function listEntries() {
  let files;
  try {
    files = await fsp.readdir(JOURNAL_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(JOURNAL_DIR, f);
    try {
      const raw = await fsp.readFile(full, "utf8");
      const doc = JSON.parse(raw);
      if (!doc || typeof doc.payload !== "string" || doc.sha256 !== sha256(doc.payload)) {
        await fsp.rename(full, `${full}.corrupt`).catch(() => {});
        continue;
      }
      out.push({ file: full, entry: JSON.parse(doc.payload) });
    } catch {
      await fsp.rename(full, `${full}.corrupt`).catch(() => {});
    }
  }
  return out;
}

module.exports = { JOURNAL_DIR, writeEntry, deleteEntry, listEntries, sha256, fileFor };
