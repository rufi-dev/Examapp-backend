const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const Board = require("../models/boardModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const Assignment = require("../models/assignmentModel");
const { detectHead } = require("../utils/fileValidation"); // magic-byte image auth

// ---- access policy ----------------------------------------------------------
// Extracted to services/boardAccessService so the realtime hub enforces the SAME
// open/edit/host rules as these HTTP handlers.
const { ownedClassIds, accessLevel, pagesOf } = require("../services/boardAccessService");
const boardHub = require("../realtime/boardHub"); // live-session registry (isLive)

// ---- private board image storage (CR-BOARD image sync) ----------------------
// Board images live on a PRIVATE volume, referenced by id — never base64 in Mongo
// or over the WebSocket. The bytes are validated by magic bytes (never the client
// MIME) and served only to the board's audience.
const BOARD_FILES_DIR = process.env.BOARD_FILES_DIR || path.join(process.cwd(), "boardFiles");
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const MAX_IMG_BYTES = 8 * 1024 * 1024; // 8 MB per image
const MAX_BOARD_FILES_BYTES = 80 * 1024 * 1024; // total per board
const safeSeg = (s) => String(s || "").replace(/[^a-fA-F0-9]/g, "").slice(0, 40);
const safeFileId = (s) => String(s || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

// ---- list boards ------------------------------------------------------------
// GET /api/boards — teacher: their own boards; ADMIN: EVERY teacher's boards (with
// ownerName); STUDENT: boards shared to any class they are approved-enrolled in
// (read-only — mine/canManage are false). Newest first.
const listBoards = asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === "admin";

  // Student: boards visible across ALL their enrolled classes — either explicitly
  // shared to a class they are in, or a teacher's "all my students" boards (empty
  // `classes`, owned by that class's teacher). This mirrors listClassBoards but
  // aggregated across every class instead of one.
  if (req.user.role === "student") {
    const enrollments = await Enrollment.find({ student: req.user._id, status: "approved" })
      .select("class")
      .lean();
    const classIds = enrollments.map((e) => e.class).filter(Boolean);
    if (!classIds.length) return res.json([]);
    const ownerRows = await Class.find({ _id: { $in: classIds }, deletedAt: null })
      .select("owner")
      .lean();
    const ownerIds = [...new Set(ownerRows.map((c) => String(c.owner)).filter(Boolean))];
    const boards = await Board.find({
      deletedAt: null,
      $or: [
        { classes: { $in: classIds } },
        { owner: { $in: ownerIds }, classes: { $size: 0 } },
      ],
    })
      .sort({ updatedAt: -1 })
      .select("title elementCount sizeBytes classes ownerName updatedAt")
      .populate("classes", "name")
      .lean();
    return res.json(boards.map((b) => ({ ...b, mine: false, canManage: false })));
  }

  const filter = isAdmin ? { deletedAt: null } : { owner: req.user._id, deletedAt: null };
  const boards = await Board.find(filter)
    .sort({ updatedAt: -1 })
    .select("title elementCount sizeBytes classes ownerName owner createdAt updatedAt")
    .populate("classes", "name")
    .lean();
  res.json(
    boards.map(({ owner, ...b }) => ({
      ...b,
      mine: String(owner) === String(req.user._id),
      canManage: isAdmin || String(owner) === String(req.user._id),
    }))
  );
});

// POST /api/boards — create a new board (one empty page) with an audience.
const createBoard = asyncHandler(async (req, res) => {
  const title = String(req.body.title || "").trim() || "Adsız lövhə";
  const classes = await ownedClassIds(req.user, req.body.classIds);
  const board = await Board.create({
    owner: req.user._id,
    ownerName: req.user.name || "",
    title,
    classes,
    pages: [{ name: "Səhifə 1", scene: null }],
  });
  res.status(201).json({ _id: board._id, title: board.title, updatedAt: board.updatedAt });
});

// GET /api/boards/:id — one board WITH pages. Owner edits; audience student views.
const getBoard = asyncHandler(async (req, res) => {
  const board = await Board.findOne({ _id: req.params.id, deletedAt: null })
    .populate("classes", "name")
    .lean();
  if (!board) return res.status(404).json({ message: "Lövhə tapılmadı" });
  const { ok, canEdit } = await accessLevel(req.user, board);
  if (!ok) return res.status(403).json({ message: "Bu lövhəyə girişiniz yoxdur" });
  res.json({
    _id: board._id,
    title: board.title,
    classes: board.classes || [],
    background: board.background || "blank",
    bgColor: board.bgColor || "",
    pages: pagesOf(board),
    canEdit,
    revision: board.revision || 0,
    // Non-null when a live session is running: the client can offer "Join live". The
    // DURABLE session flag is authoritative — a session that outlived memory eviction
    // or a restart still shows live (it rehydrates on connect).
    live:
      boardHub.isLive(board._id) ||
      (boardHub.isSessionFresh(board) ? { liveSessionId: board.liveSession.id, awaitingHost: true } : null),
    updatedAt: board.updatedAt,
  });
});

// GET /api/boards/:id/live — cheap poll: is a live session running? (Lets a
// student who already has the board open see "Join live" without a full reload.)
const boardLiveStatus = asyncHandler(async (req, res) => {
  const board = await Board.findOne({ _id: req.params.id, deletedAt: null }).select("owner classes liveSession").lean();
  if (!board) return res.status(404).json({ message: "Lövhə tapılmadı" });
  const { ok } = await accessLevel(req.user, board);
  if (!ok) return res.status(403).json({ message: "Giriş yoxdur" });
  res.json({
    live:
      boardHub.isLive(board._id) ||
      (boardHub.isSessionFresh(board) ? { liveSessionId: board.liveSession.id, awaitingHost: true } : null),
  });
});

// PATCH /api/boards/:id — save (owner only). Pages arrive as a multipart file
// (field "pages") to dodge the 100KB JSON cap; title/classes/elementCount as fields.
const saveBoard = asyncHandler(async (req, res) => {
  // Owner edits; an admin may edit any board.
  const scope = req.user.role === "admin" ? {} : { owner: req.user._id };

  const cur = await Board.findOne({ _id: req.params.id, deletedAt: null, ...scope }).select("revision liveSession").lean();
  if (!cur) return res.status(404).json({ message: "Lövhə tapılmadı" });

  // While a live session owns the board (in memory OR a durable session that
  // survived eviction/restart), the realtime hub is the single writer of the page
  // scene. Reject an HTTP PAGE write (metadata-only saves still pass).
  if (req.file && (boardHub.isLive(req.params.id) || boardHub.isSessionFresh(cur))) {
    return res.status(409).json({ message: "Lövhə canlı sessiyadadır", code: "board_live" });
  }

  const set = {};
  if (typeof req.body.title === "string" && req.body.title.trim()) set.title = req.body.title.trim().slice(0, 120);
  if (req.body.classIds !== undefined) set.classes = await ownedClassIds(req.user, req.body.classIds);
  if (req.body.elementCount !== undefined) set.elementCount = Math.max(0, Number(req.body.elementCount) || 0);
  if (["dots", "grid", "lines", "blank"].includes(req.body.background)) set.background = req.body.background;
  if (typeof req.body.bgColor === "string") {
    const c = req.body.bgColor.trim();
    if (c === "" || /^[#a-zA-Z0-9(),.%\s]{1,32}$/.test(c)) set.bgColor = c;
  }
  if (req.file && req.file.buffer) {
    let pages;
    try {
      pages = JSON.parse(req.file.buffer.toString("utf8"));
    } catch {
      return res.status(400).json({ message: "Lövhə məlumatı yanlışdır" });
    }
    if (Array.isArray(pages) && pages.length) {
      // Give each page a stable _id so the live hub can target one page (pageId).
      set.pages = pages.map((p) => ({
        _id: new mongoose.Types.ObjectId(),
        name: String(p?.name || "Səhifə").slice(0, 60),
        scene: p?.scene || null,
      }));
      set.scene = null; // legacy field retired once saved in the new shape
    }
    set.sizeBytes = req.file.buffer.length;
  }

  // ATOMIC optimistic-concurrency: bump revision only if the DB still holds the
  // revision the client based its edit on (absent-safe for legacy docs). A stale
  // second tab gets 409 instead of silently overwriting — in a single round trip,
  // with no read-then-write gap.
  const rawRev = req.body.expectedRevision;
  const revProvided = rawRev !== undefined && rawRev !== "";
  // Bounded, non-negative, SAFE integer — a huge digit string passes the regex but
  // becomes an unsafe/rounded number, so guard with Number.isSafeInteger.
  if (revProvided && (!/^\d+$/.test(String(rawRev)) || !Number.isSafeInteger(Number(rawRev)))) {
    return res.status(400).json({ message: "expectedRevision yanlışdır", code: "bad_revision" });
  }
  // A scene (pages) write MUST declare the revision it edited — a stale/modified
  // client cannot overwrite newer content by omitting it.
  if (req.file && !revProvided) {
    return res.status(400).json({ message: "expectedRevision tələb olunur", code: "revision_required" });
  }
  const expected = revProvided ? Number(rawRev) : cur.revision || 0;
  const revMatch = expected === 0 ? { $in: [0, null] } : expected;
  const updated = await Board.findOneAndUpdate(
    { _id: req.params.id, deletedAt: null, ...scope, revision: revMatch },
    { $set: set, $inc: { revision: 1 } },
    { new: true }
  ).lean();
  if (!updated) {
    return res.status(409).json({ message: "Lövhə başqa yerdə dəyişdirilib", code: "board_conflict" });
  }
  res.json({ _id: updated._id, title: updated.title, sizeBytes: updated.sizeBytes, revision: updated.revision, updatedAt: updated.updatedAt });
});

// DELETE /api/boards/:id — soft delete (owner).
const deleteBoard = asyncHandler(async (req, res) => {
  // Owner deletes; an admin may delete any board.
  const scope = req.user.role === "admin" ? {} : { owner: req.user._id };
  const board = await Board.findOneAndUpdate(
    { _id: req.params.id, deletedAt: null, ...scope },
    { $set: { deletedAt: new Date() } },
    { new: true }
  ).lean();
  if (!board) return res.status(404).json({ message: "Lövhə tapılmadı" });
  res.json({ ok: true });
});

// GET /api/boards/class/:classId — boards shared to a class, for the class page.
// Visible to the class owner/admin and its approved students. Metadata only.
const listClassBoards = asyncHandler(async (req, res) => {
  const cls = await Class.findById(req.params.classId).select("owner").lean();
  if (!cls) return res.status(404).json({ message: "Sinif tapılmadı" });
  const isManager = req.user.role === "admin" || String(cls.owner) === String(req.user._id);
  if (!isManager) {
    const enrolled = await Enrollment.findOne({
      student: req.user._id,
      class: req.params.classId,
      status: "approved",
    }).lean();
    if (!enrolled) return res.status(403).json({ message: "Bu sinfə girişiniz yoxdur" });
  }
  const boards = await Board.find({
    deletedAt: null,
    $or: [
      // The class teacher's boards shared with ALL their students.
      { owner: cls.owner, classes: { $size: 0 } },
      // Any board explicitly shared to THIS class (incl. admin-shared ones).
      { classes: cls._id },
    ],
  })
    .sort({ updatedAt: -1 })
    .select("title elementCount classes updatedAt owner")
    .populate("classes", "name")
    .lean();
  // `canManage` = the viewer may share/delete this board (its owner, or an admin);
  // don't leak the raw owner id to the client.
  const isAdmin = req.user.role === "admin";
  res.json(
    boards.map(({ owner, ...b }) => ({
      ...b,
      canManage: isAdmin || String(owner) === String(req.user._id),
    }))
  );
});

// POST /api/boards/:id/files — the OWNER/admin uploads a board image (multipart
// "file"). Validated by magic bytes (never the client MIME), size-capped per image
// and per board. Returns { fileId, hash, mime, size } — the id/hash referenced over
// the live socket and persisted in the scene. Content-addressed (same bytes → same
// id) so a re-upload is idempotent.
const uploadBoardFile = asyncHandler(async (req, res) => {
  const scope = req.user.role === "admin" ? {} : { owner: req.user._id };
  const board = await Board.findOne({ _id: req.params.id, deletedAt: null, ...scope }).select("_id").lean();
  if (!board) return res.status(404).json({ message: "Lövhə tapılmadı" });
  const buf = req.file && req.file.buffer;
  if (!buf || !buf.length) return res.status(400).json({ message: "Fayl yoxdur" });
  if (buf.length > MAX_IMG_BYTES) return res.status(413).json({ message: "Şəkil çox böyükdür (maksimum 8MB)" });
  // Authenticate the bytes: only real PNG/JPEG/GIF/WebP images.
  const det = detectHead(buf.slice(0, 64));
  const kind = det && ["png", "jpg", "gif", "webp"].includes(det.type) ? det.type : null;
  if (!kind) return res.status(415).json({ message: "Yalnız PNG, JPEG, GIF və ya WebP şəkillər" });

  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  // Store under the ELEMENT's fileId (what the scene references + viewers fetch by).
  // Fall back to a content-addressed id if none supplied.
  const fileId = req.body && req.body.fileId ? safeFileId(req.body.fileId) : hash.slice(0, 40);
  if (!fileId) return res.status(400).json({ message: "fileId yanlışdır" });
  const dir = path.join(BOARD_FILES_DIR, safeSeg(String(req.params.id)));
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, safeFileId(fileId));

  // Idempotent: if the exact file already exists, don't re-count it toward the cap.
  const already = await fsp.stat(target).then((s) => s.size, () => 0);
  if (!already) {
    let total = 0;
    try {
      const names = await fsp.readdir(dir);
      for (const n of names) total += await fsp.stat(path.join(dir, n)).then((s) => s.size, () => 0);
    } catch { /* fresh dir */ }
    if (total + buf.length > MAX_BOARD_FILES_BYTES) return res.status(413).json({ message: "Lövhənin şəkil həcmi limitini keçdi" });
    // Atomic write: temp → rename.
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, target);
  }
  res.json({ fileId, hash, mime: IMG_MIME[kind], size: buf.length });
});

// GET /api/boards/:id/files/:fileId — serve a board image to the audience (owner/
// admin/enrolled). Content-type is sniffed from the bytes, never trusted from input.
const getBoardFile = asyncHandler(async (req, res) => {
  const board = await Board.findOne({ _id: req.params.id, deletedAt: null }).select("owner classes").lean();
  if (!board) return res.status(404).json({ message: "Tapılmadı" });
  const { ok } = await accessLevel(req.user, board);
  if (!ok) return res.status(403).json({ message: "Giriş yoxdur" });
  const target = path.join(BOARD_FILES_DIR, safeSeg(String(req.params.id)), safeFileId(req.params.fileId));
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return res.status(404).json({ message: "Şəkil tapılmadı" });
  }
  let mime = "application/octet-stream";
  try {
    const fh = await fsp.open(target, "r");
    const head = Buffer.alloc(64);
    await fh.read(head, 0, 64, 0);
    await fh.close();
    const det = detectHead(head);
    if (det && IMG_MIME[det.type]) mime = IMG_MIME[det.type];
  } catch { /* fall back to octet-stream */ }
  res.setHeader("Content-Type", mime);
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  fs.createReadStream(target).pipe(res);
});

// POST /api/boards/homework/:assignmentId — a student opens (creating on first use)
// their OWN solve-board for a board-enabled assignment. One board per (assignment,
// student); returns its id so the client can navigate to the editor.
const getOrCreateHomeworkBoard = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.assignmentId).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapşırıq tapılmadı" });
  if (!a.boardEnabled) return res.status(400).json({ message: "Bu tapşırıq üçün lövhə aktiv deyil" });
  const enrolled = await Enrollment.exists({ class: a.class, student: req.user._id, status: "approved" });
  if (!enrolled) return res.status(403).json({ message: "Yalnız bu sinifin şagirdi lövhədə həll edə bilər" });

  let board = await Board.findOne({ assignment: a._id, student: req.user._id, deletedAt: null });
  if (!board) {
    board = await Board.create({
      owner: a.owner,
      ownerName: a.ownerName || "",
      title: `${a.title} — ${req.user.name || "Şagird"}`,
      assignment: a._id,
      student: req.user._id,
      classes: [],
      pages: [{ name: "Səhifə 1", scene: null }],
    });
  }
  res.json({ _id: board._id });
});

// GET /api/boards/homework/:assignmentId/list — the assignment owner lists every
// student's solve-board for it (to open and mark).
const listHomeworkBoards = asyncHandler(async (req, res) => {
  const a = await Assignment.findById(req.params.assignmentId).lean();
  if (!a || a.deletedAt) return res.status(404).json({ message: "Tapşırıq tapılmadı" });
  if (String(a.owner) !== String(req.user._id) && req.user.role !== "admin") {
    return res.status(403).json({ message: "İcazə yoxdur" });
  }
  const boards = await Board.find({ assignment: a._id, deletedAt: null })
    .select("_id student title updatedAt elementCount")
    .populate("student", "name email photo")
    .sort({ updatedAt: -1 })
    .lean();
  res.json({ boards });
});

module.exports = { listBoards, createBoard, getBoard, boardLiveStatus, saveBoard, deleteBoard, listClassBoards, uploadBoardFile, getBoardFile, getOrCreateHomeworkBoard, listHomeworkBoards };
