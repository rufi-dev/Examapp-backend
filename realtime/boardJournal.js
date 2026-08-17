/*
 * Durable write-ahead journal for live whiteboard sessions (CR-BOARD-005).
 *
 * Guarantees:
 *  - Every write / delete / read for a board runs through ONE serialized per-board
 *    queue, so a stale delete can never race a newer write.
 *  - Each journal has an immutable journalId + a scene hash. A delete only removes
 *    the file if its journalId matches — an older cleanup cannot delete a newer
 *    journal.
 *  - Writes are atomic and durable: temp -> fsync file -> rename -> fsync dir. Any
 *    fsync/rename error PROPAGATES (the caller must not acknowledge on throw).
 *  - A startup preflight proves the directory is absolute, writable, a real (non
 *    symlink) directory, and that write->fsync->rename->dir-fsync works. Until it
 *    passes, `isHealthy()` is false and the hub refuses to accept edits.
 *  - Only ENOENT is treated as "already gone" on delete; other fs errors throw.
 */
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const JOURNAL_DIR = process.env.LIVE_JOURNAL_DIR || path.join(process.cwd(), "live-journal");
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024; // hard cap on a single journal document
const MAX_ELEMENTS = 6000;

let storageHealthy = false;

// ---- per-board serialized operation queue -----------------------------------
const chains = new Map();
function enqueue(boardId, op) {
  const key = String(boardId);
  const prev = chains.get(key) || Promise.resolve();
  const run = prev.then(op, op); // run regardless of the previous op's outcome
  chains.set(key, run.catch(() => {})); // stored chain never rejects (keeps ordering)
  return run; // caller sees the real result/error
}

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const safeId = (id) => String(id).replace(/[^a-fA-F0-9]/g, "");
const fileFor = (boardId) => path.join(JOURNAL_DIR, `${safeId(boardId)}.json`);

// fsync the directory so the atomic rename itself is durable (POSIX). On LINUX
// (production) EVERY fsync error propagates — a failed dir-fsync means the write is
// not proven durable. Windows genuinely cannot fsync a directory handle, so ONLY
// there, and only for the narrow "unsupported" codes, is it tolerated.
const WIN_DIR_FSYNC_UNSUPPORTED = new Set(["EPERM", "EINVAL", "EISDIR", "ENOSYS"]);
async function syncDir() {
  let dh;
  try {
    dh = await fsp.open(JOURNAL_DIR, "r");
    await dh.sync();
  } catch (e) {
    if (!(process.platform === "win32" && WIN_DIR_FSYNC_UNSUPPORTED.has(e.code))) throw e;
  } finally {
    if (dh) await dh.close().catch(() => {});
  }
}

// Startup preflight — must pass before any durable ack is possible.
async function preflight() {
  storageHealthy = false;
  if (!path.isAbsolute(JOURNAL_DIR)) throw new Error(`journal dir must be absolute: ${JOURNAL_DIR}`);
  await fsp.mkdir(JOURNAL_DIR, { recursive: true });
  const st = await fsp.lstat(JOURNAL_DIR);
  if (st.isSymbolicLink()) throw new Error("journal dir must not be a symlink");
  if (!st.isDirectory()) throw new Error("journal path is not a directory");
  const tmp = path.join(JOURNAL_DIR, `.preflight-${process.pid}.tmp`);
  const dst = path.join(JOURNAL_DIR, `.preflight-${process.pid}`);
  const fh = await fsp.open(tmp, "w");
  try {
    await fh.writeFile("ok");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fsp.rename(tmp, dst);
  await syncDir();
  await fsp.unlink(dst).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  storageHealthy = true;
}

const isHealthy = () => storageHealthy;

function validate(entry) {
  if (!entry || typeof entry.boardId !== "string" || typeof entry.pageId !== "string") throw new Error("bad journal entry");
  if (!entry.scene || !Array.isArray(entry.scene.elements)) throw new Error("bad journal scene");
  if (entry.scene.elements.length > MAX_ELEMENTS) throw new Error("journal scene too large (elements)");
}

// Durable write. Returns { journalId, hash }. Serialized per board. THROWS on any
// storage failure so the caller does not acknowledge a non-durable change.
function writeEntry(entry) {
  return enqueue(entry.boardId, async () => {
    if (!storageHealthy) throw new Error("journal storage unavailable");
    validate(entry);
    const journalId = crypto.randomUUID();
    const hash = sha256(JSON.stringify(entry.scene));
    const payload = JSON.stringify({ ...entry, journalId, hash });
    if (payload.length > MAX_JOURNAL_BYTES) throw new Error("journal entry too large");
    const doc = JSON.stringify({ v: 1, sha256: sha256(payload), payload });
    const target = fileFor(entry.boardId);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const fh = await fsp.open(tmp, "w");
    try {
      await fh.writeFile(doc);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fsp.rename(tmp, target);
    await syncDir(); // propagates → no ack on failure
    return { journalId, hash };
  });
}

// Raw (non-queued) read. Returns { kind: "absent" | "corrupt" | "ok", entry? }.
// A corrupt/checksum-invalid file is quarantined DURABLY (rename + dir fsync);
// quarantine failures propagate. ENOENT → absent; other read errors propagate.
async function _scan(boardId) {
  const target = fileFor(boardId);
  let raw;
  try {
    raw = await fsp.readFile(target, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { kind: "absent" };
    throw e;
  }
  try {
    const doc = JSON.parse(raw);
    if (!doc || typeof doc.payload !== "string" || doc.sha256 !== sha256(doc.payload)) throw new Error("checksum");
    return { kind: "ok", entry: JSON.parse(doc.payload) };
  } catch {
    await fsp.rename(target, `${target}.corrupt`); // durable quarantine (throws propagate)
    await syncDir();
    return { kind: "corrupt" };
  }
}

// Read the current entry (serialized). Returns the entry, or null (absent /
// corrupt-after-quarantine). For corruption-AWARE recovery use listEntries().
function readEntry(boardId) {
  return enqueue(boardId, async () => {
    const r = await _scan(boardId);
    return r.kind === "ok" ? r.entry : null;
  });
}

// Delete ONLY if the current file's journalId matches (a stale delete for an old
// journalId is a no-op — it will not remove a newer journal). Serialized per
// board. Only ENOENT is ignored; other fs errors throw.
function deleteEntry(boardId, journalId) {
  return enqueue(boardId, async () => {
    const target = fileFor(boardId);
    let raw;
    try {
      raw = await fsp.readFile(target, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
    if (journalId) {
      try {
        const doc = JSON.parse(raw);
        const entry = doc && typeof doc.payload === "string" ? JSON.parse(doc.payload) : null;
        if (entry && entry.journalId && entry.journalId !== journalId) return false; // newer journal present
      } catch {
        /* corrupt — fall through and remove it */
      }
    }
    await fsp.unlink(target).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    await syncDir(); // propagates (Linux) — a deletion is not proven durable otherwise
    return true;
  });
}

// Every current journal, for boot replay. THROWS if the directory can't be
// enumerated (so the hub never reports "recovery complete" without examining the
// files). Each record is { boardId, entry } for a valid journal or
// { boardId, corrupt: true } for a quarantined one — corruption is never silently
// dropped.
async function listEntries() {
  const files = await fsp.readdir(JOURNAL_DIR); // throws on enumeration failure
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const boardId = f.replace(/\.json$/, "");
    const r = await enqueue(boardId, () => _scan(boardId));
    if (r.kind === "ok") out.push({ boardId, entry: r.entry });
    else if (r.kind === "corrupt") out.push({ boardId, corrupt: true });
  }
  return out;
}

module.exports = { JOURNAL_DIR, preflight, isHealthy, writeEntry, deleteEntry, readEntry, listEntries, sha256, fileFor };
