const asyncHandler = require("express-async-handler");
const mongoose = require("mongoose");
const Board = require("../models/boardModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

// ---- access policy ----------------------------------------------------------
// Extracted to services/boardAccessService so the realtime hub enforces the SAME
// open/edit/host rules as these HTTP handlers.
const { ownedClassIds, accessLevel, pagesOf } = require("../services/boardAccessService");
const boardHub = require("../realtime/boardHub"); // live-session registry (isLive)

// ---- teacher: manage own boards ---------------------------------------------
// GET /api/boards — a teacher's own boards; an ADMIN sees EVERY teacher's boards
// (with ownerName), newest first. `mine`/`canManage` let the client label and gate.
const listBoards = asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === "admin";
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
      (board.liveSession && board.liveSession.active ? { liveSessionId: board.liveSession.id, awaitingHost: true } : null),
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
      (board.liveSession && board.liveSession.active ? { liveSessionId: board.liveSession.id, awaitingHost: true } : null),
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
  if (req.file && (boardHub.isLive(req.params.id) || (cur.liveSession && cur.liveSession.active))) {
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

module.exports = { listBoards, createBoard, getBoard, boardLiveStatus, saveBoard, deleteBoard, listClassBoards };
