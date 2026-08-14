const asyncHandler = require("express-async-handler");
const Board = require("../models/boardModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");

// ---- audience / access helpers (mirror materialController) -------------------
async function studentScope(studentId) {
  const classIds = await Enrollment.find({ student: studentId, status: "approved" }).distinct("class");
  const ownerIds = classIds.length
    ? await Class.find({ _id: { $in: classIds } }).distinct("owner")
    : [];
  return { classIds: classIds.map(String), ownerIds: ownerIds.map(String) };
}

// Keep only the classes this user may publish to (their own; admins: any).
async function ownedClassIds(user, raw) {
  let ids = raw;
  if (typeof ids === "string") {
    try {
      ids = JSON.parse(ids);
    } catch {
      ids = ids ? [ids] : [];
    }
  }
  if (!Array.isArray(ids)) ids = ids ? [ids] : [];
  ids = ids.filter(Boolean).map(String);
  if (!ids.length) return [];
  const found = await Class.find({ _id: { $in: ids } }).select("owner").lean();
  return found
    .filter((c) => user.role === "admin" || String(c.owner) === String(user._id))
    .map((c) => String(c._id));
}

const audienceOf = (b) => (b.classes?.length ? b.classes.map(String) : []);

// Owner/admin may EDIT; a student in the audience may only VIEW. Returns
// { ok, canEdit } so the caller can gate reading vs writing.
async function accessLevel(user, board) {
  if (!board) return { ok: false, canEdit: false };
  if (user.role === "admin") return { ok: true, canEdit: true };
  if (String(board.owner) === String(user._id)) return { ok: true, canEdit: true };
  if (user.role === "teacher") return { ok: false, canEdit: false };
  const { classIds, ownerIds } = await studentScope(user._id);
  const audience = audienceOf(board);
  if (!audience.length) {
    // Empty audience = "all of the board owner's students": the student must be
    // enrolled in a class owned by the board's owner.
    return { ok: ownerIds.includes(String(board.owner)), canEdit: false };
  }
  // Explicit classes: a student in any listed class may view it — even if the
  // board was shared by an admin who doesn't own that class.
  return { ok: audience.some((c) => classIds.includes(c)), canEdit: false };
}

// Migrate a legacy single-scene board to a one-page shape on read; guarantee at
// least one page so the editor always has something to show.
const pagesOf = (board) => {
  if (board.pages && board.pages.length) return board.pages;
  if (board.scene) return [{ name: "Səhifə 1", scene: board.scene }];
  return [{ name: "Səhifə 1", scene: null }];
};

// ---- teacher: manage own boards ---------------------------------------------
// GET /api/boards — the teacher's boards (metadata + audience), newest first.
const listBoards = asyncHandler(async (req, res) => {
  const boards = await Board.find({ owner: req.user._id, deletedAt: null })
    .sort({ updatedAt: -1 })
    .select("title elementCount sizeBytes classes createdAt updatedAt")
    .populate("classes", "name")
    .lean();
  res.json(boards.map((b) => ({ ...b, pageCount: undefined })));
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
    updatedAt: board.updatedAt,
  });
});

// PATCH /api/boards/:id — save (owner only). Pages arrive as a multipart file
// (field "pages") to dodge the 100KB JSON cap; title/classes/elementCount as fields.
const saveBoard = asyncHandler(async (req, res) => {
  const board = await Board.findOne({ _id: req.params.id, owner: req.user._id, deletedAt: null });
  if (!board) return res.status(404).json({ message: "Lövhə tapılmadı" });

  if (typeof req.body.title === "string" && req.body.title.trim()) {
    board.title = req.body.title.trim().slice(0, 120);
  }
  if (req.body.classIds !== undefined) {
    board.classes = await ownedClassIds(req.user, req.body.classIds);
  }
  if (req.body.elementCount !== undefined) {
    board.elementCount = Math.max(0, Number(req.body.elementCount) || 0);
  }
  if (["dots", "grid", "lines", "blank"].includes(req.body.background)) {
    board.background = req.body.background;
  }
  // Canvas base colour: a CSS colour (#hex / rgb() / named / "transparent"),
  // kept short and character-restricted so nothing unexpected is stored.
  if (typeof req.body.bgColor === "string") {
    const c = req.body.bgColor.trim();
    if (c === "" || /^[#a-zA-Z0-9(),.%\s]{1,32}$/.test(c)) board.bgColor = c;
  }
  if (req.file && req.file.buffer) {
    let pages;
    try {
      pages = JSON.parse(req.file.buffer.toString("utf8"));
    } catch {
      return res.status(400).json({ message: "Lövhə məlumatı yanlışdır" });
    }
    if (Array.isArray(pages) && pages.length) {
      board.pages = pages.map((p) => ({ name: String(p?.name || "Səhifə").slice(0, 60), scene: p?.scene || null }));
      board.scene = null; // legacy field retired once saved in the new shape
    }
    board.sizeBytes = req.file.buffer.length;
  }
  await board.save();
  res.json({ _id: board._id, title: board.title, sizeBytes: board.sizeBytes, updatedAt: board.updatedAt });
});

// DELETE /api/boards/:id — soft delete (owner).
const deleteBoard = asyncHandler(async (req, res) => {
  const board = await Board.findOneAndUpdate(
    { _id: req.params.id, owner: req.user._id, deletedAt: null },
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
  // `canManage` = the viewer owns this board (share/delete endpoints require it);
  // don't leak the raw owner id to the client.
  res.json(
    boards.map(({ owner, ...b }) => ({ ...b, canManage: String(owner) === String(req.user._id) }))
  );
});

module.exports = { listBoards, createBoard, getBoard, saveBoard, deleteBoard, listClassBoards };
