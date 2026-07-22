const asyncHandler = require("express-async-handler");
const fs = require("fs");
const path = require("path");
const Material = require("../models/materialModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const { notifyEnrollment } = require("../helper/telegram");
const { convertOfficeToPdf, isOfficeFile } = require("../utils/officeToPdf");

// PRIVATE storage — deliberately NOT under uploads/, which express.static
// serves publicly. Nothing here is reachable without passing the access check
// in this controller.
const MATERIALS_DIR = path.join(process.cwd(), "materials");
if (!fs.existsSync(MATERIALS_DIR)) fs.mkdirSync(MATERIALS_DIR, { recursive: true });

const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif|heic|heif)$/i;

// The set of classes a student is approved-enrolled in, plus the teachers who
// own them. Both are needed: the teacher list decides WHOSE materials are
// visible, the class list decides which class-scoped ones are.
async function studentScope(studentId) {
  const classIds = await Enrollment.find({
    student: studentId,
    status: "approved",
  }).distinct("class");
  const ownerIds = classIds.length
    ? await Class.find({ _id: { $in: classIds } }).distinct("owner")
    : [];
  return { classIds, ownerIds };
}

// Keep only the classes this user may publish to (their own; admins: any).
// Accepts an array, a JSON string (multipart sends strings) or a single id.
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

// A doc's audience: the new list, falling back to the legacy single class so
// anything published before multi-class support keeps working.
const audienceOf = (doc) =>
  doc.classes?.length ? doc.classes.map(String) : doc.class ? [String(doc.class)] : [];

// Mongo form of the same rule: shared-with-everyone, or overlapping the
// student's classes (checking both the new list and the legacy field).
const audienceFilter = (classIds) => ({
  $or: [
    {
      $and: [
        { $or: [{ classes: { $exists: false } }, { classes: { $size: 0 } }] },
        { $or: [{ class: null }, { class: { $exists: false } }] },
      ],
    },
    { classes: { $in: classIds } },
    { class: { $in: classIds } },
  ],
});

// Can this user open this material? Mirrors the list filter below.
async function canAccess(user, material) {
  if (!material) return false;
  if (user.role === "admin") return true;
  if (String(material.owner) === String(user._id)) return true; // the owning teacher
  if (user.role === "teacher") return false; // never another teacher's material
  const { classIds, ownerIds } = await studentScope(user._id);
  const fromMyTeacher = ownerIds.some((o) => String(o) === String(material.owner));
  if (!fromMyTeacher) return false;
  const audience = audienceOf(material);
  if (!audience.length) return true; // shared with all of that teacher's students
  return classIds.some((c) => audience.includes(String(c)));
}

// GET /api/materials — scoped list (see materialModel for the rules).
const getMaterials = asyncHandler(async (req, res) => {
  let filter;
  if (req.user.role === "admin") {
    filter = {};
  } else if (req.user.role === "teacher") {
    filter = { owner: req.user._id };
  } else {
    const { classIds, ownerIds } = await studentScope(req.user._id);
    if (!ownerIds.length) return res.json([]);
    filter = { owner: { $in: ownerIds }, ...audienceFilter(classIds) };
  }
  const materials = await Material.find(filter)
    .sort({ createdAt: -1 })
    .populate("classes", "name level").populate("class", "name level")
    .lean();
  // `share` is owner-only. It holds the live link token and the reader list
  // WITH EMAIL ADDRESSES; students can legitimately see a teacher's material,
  // and sending them the whole document would hand them both.
  const isOwner = (m) =>
    req.user.role === "admin" || String(m.owner) === String(req.user._id);
  materials.forEach((m) => {
    if (!isOwner(m)) delete m.share;
  });
  res.json(materials);
});

// POST /api/materials — teacher/admin uploads a file (multipart).
// Word/PowerPoint are converted to PDF here so the viewer stays simple.
const addMaterial = asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: "Fayl seçin" });

  const cleanup = (p) => {
    try {
      if (p && fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* best effort */
    }
  };

  const title = String(req.body.title || "").trim();
  if (!title) {
    cleanup(file.path);
    return res.status(400).json({ message: "Başlıq daxil edin" });
  }

  let storedPath = file.path;
  let kind;
  let mimeType = file.mimetype || "";

  if (IMAGE_MIME.test(file.mimetype || "")) {
    kind = "image";
  } else if ((file.mimetype || "").toLowerCase() === "application/pdf") {
    kind = "pdf";
  } else if (isOfficeFile(file.originalname)) {
    try {
      const pdfPath = await convertOfficeToPdf(file.path, MATERIALS_DIR);
      cleanup(file.path); // keep only the PDF
      storedPath = pdfPath;
      kind = "pdf";
      mimeType = "application/pdf";
    } catch (e) {
      cleanup(file.path);
      return res.status(400).json({ message: e.message });
    }
  } else {
    cleanup(file.path);
    return res
      .status(400)
      .json({ message: "Yalnız PDF, şəkil, Word və ya PowerPoint faylı yükləyin" });
  }

  // Only allow attaching to classes the uploader actually owns. Empty = all.
  const classIds = await ownedClassIds(req.user, req.body.classIds ?? req.body.classId);

  let sizeBytes = 0;
  try {
    sizeBytes = fs.statSync(storedPath).size;
  } catch {
    /* non-fatal */
  }

  const material = await Material.create({
    title,
    description: String(req.body.description || "").trim(),
    coverImage: String(req.body.coverImage || "").trim(),
    fileName: path.basename(storedPath),
    originalName: file.originalname || "",
    kind,
    mimeType,
    sizeBytes,
    classes: classIds,
    class: null,
    // Checkboxes arrive as the string "true" from multipart form data.
    allowDownload: String(req.body.allowDownload) === "true",
    allowCopy: String(req.body.allowCopy) === "true",
    owner: req.user._id,
    ownerName: req.user.name || "",
  });

  const populated = await Material.findById(material._id)
    .populate("classes", "name level").populate("class", "name level")
    .lean();
  res.status(201).json(populated);
});

// Shared by the view + download endpoints: resolve the material, check access,
// and make sure the file is still on disk.
async function loadForRead(req, res) {
  const material = await Material.findById(req.params.id);
  if (!material) {
    res.status(404).json({ message: "Tapılmadı" });
    return null;
  }
  if (!(await canAccess(req.user, material))) {
    res.status(403).json({ message: "Bu materiala girişiniz yoxdur" });
    return null;
  }
  const abs = path.join(MATERIALS_DIR, material.fileName);
  // Defensive: never let a crafted fileName escape the materials dir.
  if (!abs.startsWith(MATERIALS_DIR) || !fs.existsSync(abs)) {
    res.status(404).json({ message: "Fayl tapılmadı" });
    return null;
  }
  return { material, abs };
}

// GET /api/materials/:id/file — stream for the in-app viewer (inline, never
// as an attachment). The client fetches this with its auth header and renders
// the blob, so students never receive a shareable file URL.
const viewMaterial = asyncHandler(async (req, res) => {
  const loaded = await loadForRead(req, res);
  if (!loaded) return;
  const { material, abs } = loaded;
  // sendFile (not createReadStream) so the response honours Range requests.
  // pdf.js asks for byte ranges and renders the first pages while the rest of
  // a large file is still on the wire; piping the whole stream forced the
  // reader to download every page before showing anything.
  res.sendFile(abs, {
    acceptRanges: true,
    headers: {
      "Content-Type": material.mimeType || "application/octet-stream",
      "Content-Disposition": "inline",
      // `private` (not no-store) so the browser may reuse ranges it already
      // holds; it still never lands in a shared cache.
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

// GET /api/materials/:id/download — only when the teacher allowed it (the
// owner/admin can always fetch their own file).
const downloadMaterial = asyncHandler(async (req, res) => {
  const loaded = await loadForRead(req, res);
  if (!loaded) return;
  const { material, abs } = loaded;
  const privileged =
    req.user.role === "admin" || String(material.owner) === String(req.user._id);
  if (!material.allowDownload && !privileged) {
    return res
      .status(403)
      .json({ message: "Bu materialı yükləmək icazəsi yoxdur" });
  }
  const ext = material.kind === "pdf" ? ".pdf" : path.extname(material.fileName);
  const safeName = `${material.title.replace(/[\\/:*?"<>|]+/g, "_")}${ext}`;
  res.download(abs, safeName);
});

// PATCH /api/materials/:id — owner/admin edits title, description or the
// download permission.
const updateMaterial = asyncHandler(async (req, res) => {
  const material = await Material.findById(req.params.id);
  if (!material) return res.status(404).json({ message: "Tapılmadı" });
  const isOwner = String(material.owner) === String(req.user._id);
  if (!isOwner && req.user.role !== "admin") {
    return res.status(403).json({ message: "Bu material sizə aid deyil" });
  }
  if (typeof req.body.title === "string" && req.body.title.trim()) {
    material.title = req.body.title.trim();
  }
  if (typeof req.body.description === "string") {
    material.description = req.body.description.trim();
  }
  if (typeof req.body.coverImage === "string") {
    material.coverImage = req.body.coverImage.trim();
  }
  if (typeof req.body.allowDownload === "boolean") {
    material.allowDownload = req.body.allowDownload;
  }
  if (typeof req.body.allowCopy === "boolean") {
    material.allowCopy = req.body.allowCopy;
  }
  // Re-target the material at other classes (or back to "all my students").
  // Same ownership rule as upload.
  if (
    Object.prototype.hasOwnProperty.call(req.body, "classIds") ||
    Object.prototype.hasOwnProperty.call(req.body, "classId")
  ) {
    material.classes = await ownedClassIds(req.user, req.body.classIds ?? req.body.classId);
    material.class = null; // the list is authoritative from here on
  }
  await material.save();
  const populated = await Material.findById(material._id)
    .populate("classes", "name level").populate("class", "name level")
    .lean();
  res.json(populated);
});

// DELETE /api/materials/:id — owner/admin; removes the row and the file.
const deleteMaterial = asyncHandler(async (req, res) => {
  const material = await Material.findById(req.params.id);
  if (!material) return res.status(404).json({ message: "Tapılmadı" });
  const isOwner = String(material.owner) === String(req.user._id);
  if (!isOwner && req.user.role !== "admin") {
    return res.status(403).json({ message: "Bu material sizə aid deyil" });
  }
  try {
    const abs = path.join(MATERIALS_DIR, material.fileName);
    if (abs.startsWith(MATERIALS_DIR) && fs.existsSync(abs)) fs.unlinkSync(abs);
  } catch {
    /* keep going — the row must still go */
  }
  await material.deleteOne();
  res.json({ id: req.params.id });
});

// ───────────────────────── public share links ─────────────────────────
//
// A share link carries its own secret. The material id never appears in it, so
// a leaked link exposes exactly one material and nothing about the account
// behind it. Turning sharing off closes the link at once but keeps the token,
// so switching it back on does not break a link already handed out.
const crypto = require("crypto");

const shareUrl = (token) =>
  `${(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/m/${token}`;

const shareState = (m) => ({
  enabled: !!m.share?.enabled,
  requireAuth: !!m.share?.requireAuth,
  joinClass: m.share?.joinClass ? String(m.share.joinClass) : null,
  token: m.share?.token || null,
  url: m.share?.token ? shareUrl(m.share.token) : null,
  views: m.share?.views || 0,
  readers: (m.share?.readers || [])
    .slice()
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .map((r) => ({ name: r.name, email: r.email, at: r.at })),
});

// PATCH /api/materials/:id/share — owner only. { enabled, requireAuth }
const setMaterialShare = asyncHandler(async (req, res) => {
  const material = await Material.findById(req.params.id);
  if (!material) {
    res.status(404);
    throw new Error("Tapılmadı");
  }
  const owns =
    req.user.role === "admin" || String(material.owner) === String(req.user._id);
  if (!owns) {
    res.status(403);
    throw new Error("Bu materialı paylaşa bilməzsiniz");
  }

  const enabled = req.body?.enabled === true || req.body?.enabled === "true";
  const requireAuth = req.body?.requireAuth === true || req.body?.requireAuth === "true";

  // The class the link invites into. Validated against what this teacher
  // actually owns — the id arrives from a browser, and an unchecked one would
  // let a teacher hand out entry to somebody else's class.
  let joinClass = null;
  if (requireAuth && req.body?.joinClass) {
    const cls = await Class.findById(String(req.body.joinClass)).select("owner").lean();
    const ownsClass =
      cls && (req.user.role === "admin" || String(cls.owner) === String(material.owner));
    if (!ownsClass) {
      res.status(400);
      throw new Error("Bu sinif sizin deyil");
    }
    joinClass = cls._id;
  }
  // Not picked: fall back to the only class it is shared with, when there is
  // exactly one — the common case, where asking would be pointless.
  if (requireAuth && !joinClass) {
    const audience = audienceOf(material);
    if (audience.length === 1) joinClass = audience[0];
  }

  material.share = material.share || {};
  if (enabled && !material.share.token) {
    // 48 hex chars. This is the entire access control for a public link, so it
    // has to be far past guessing rather than merely "random looking".
    material.share.token = crypto.randomBytes(24).toString("hex");
    material.share.createdAt = new Date();
  }
  material.share.enabled = enabled;
  material.share.requireAuth = requireAuth;
  material.share.joinClass = joinClass;
  // Sign-in is what makes a reader identifiable; without it the list would
  // freeze half-filled and read as though nobody else opened the link.
  if (!requireAuth) material.share.readers = [];
  await material.save();
  res.json(shareState(material));
});

// Loads a shared material by token, or answers the request itself and returns
// null. `needsAuth` is a 200, not a 401: the page has to render a sign-in
// prompt, and a 401 would be indistinguishable from a dead link.
async function loadShared(req, res) {
  const token = String(req.params.token || "");
  if (token.length < 32) {
    res.status(404).json({ message: "Link tapılmadı" });
    return null;
  }
  const material = await Material.findOne({ "share.token": token });
  if (!material || !material.share?.enabled) {
    res.status(404).json({ message: "Link tapılmadı və ya bağlanıb" });
    return null;
  }
  return material;
}

// Records who opened it. Deduped per person — a teacher wants the roll call,
// not a click log — and capped so a popular link cannot grow the document
// without bound.
async function noteRead(material, user) {
  const inc = { "share.views": 1 };
  if (!user || !material.share?.requireAuth) {
    await Material.updateOne({ _id: material._id }, { $inc: inc });
    return;
  }
  const existing = (material.share.readers || []).find(
    (r) => String(r.user) === String(user._id)
  );
  if (existing) {
    await Material.updateOne(
      { _id: material._id, "share.readers.user": user._id },
      { $inc: inc, $set: { "share.readers.$.at": new Date() } }
    );
    return;
  }
  await Material.updateOne(
    { _id: material._id },
    {
      $inc: inc,
      $push: {
        "share.readers": {
          $each: [{ user: user._id, name: user.name, email: user.email, at: new Date() }],
          $slice: -500,
        },
      },
    }
  );
}

// GET /api/materials/share/:token — what the public page needs to render.
// Deliberately thin: title, kind and the reading flags. No owner id, no
// material id, nothing about the rest of the account.
const getSharedMaterial = asyncHandler(async (req, res) => {
  const material = await loadShared(req, res);
  if (!material) return;

  // "Sign-in required" means the reader must be a STUDENT OF THIS MATERIAL, not
  // merely someone with an account: the same rule the in-app library applies.
  // An account alone would let anyone with the link identify themselves and
  // read, which is the open mode with extra steps.
  const requireAuth = !!material.share.requireAuth;
  const needsAuth = requireAuth && !req.user;
  let needsJoin = false;
  let classNames = [];
  let joinCode = null;
  let joinClassName = "";
  if (requireAuth && req.user && !(await canAccess(req.user, material))) {
    needsJoin = true;
    // Names only, fetched separately: populating the material would replace
    // the class ids that canAccess compares against. The join CODE is what
    // grants entry, so it stays out of a response anyone holding the link reads.
    const audience = audienceOf(material);
    if (audience.length) {
      const rows = await Class.find({ _id: { $in: audience } }).select("name level").lean();
      classNames = rows
        .map((c) => c.name || (c.level != null ? `${c.level} sinif` : ""))
        .filter(Boolean);
    }
    // The code is the teacher's chosen class, however many the material is
    // shared with. It only goes to someone SIGNED IN and still shut out —
    // exactly the person who needs it, and who can already join through the
    // button beside it, so it grants nothing extra. Never in an anonymous
    // response.
    if (material.share.joinClass) {
      const target = await Class.findById(material.share.joinClass)
        .select("name level joinCode")
        .lean();
      if (target) {
        joinCode = target.joinCode || null;
        joinClassName = target.name || (target.level != null ? `${target.level} sinif` : "");
      }
    }
  }

  res.json({
    needsJoin,
    classNames,
    joinCode,
    joinClassName,
    title: material.title,
    description: material.description || "",
    kind: material.kind,
    ownerName: material.ownerName || "",
    sizeBytes: material.sizeBytes || 0,
    allowDownload: !!material.allowDownload,
    allowCopy: !!material.allowCopy,
    requireAuth: !!material.share.requireAuth,
    needsAuth,
  });
});

// POST /api/materials/share/:token/join — put the caller in the class this
// material belongs to.
//
// A gated link IS an invitation: joining by code is approved on the spot
// elsewhere in the app, so a link the teacher chose to send is the same grant
// by another route. It only ever joins the class this ONE material is shared
// with, never anything else the teacher owns.
//
// With no specific audience ("all my students") there is no single class to
// join, and picking one for them would be a guess — so it says so instead.
const joinFromShare = asyncHandler(async (req, res) => {
  const material = await loadShared(req, res);
  if (!material) return;
  if (!material.share.requireAuth) return res.json({ joined: true, reason: "open" });
  if (await canAccess(req.user, material)) return res.json({ joined: true, already: true });

  // The class the teacher named when they gated the link. Falling back to the
  // audience covers links created before the picker existed.
  const audience = audienceOf(material);
  const targetId =
    material.share.joinClass || (audience.length === 1 ? audience[0] : null);
  if (!targetId) return res.json({ joined: false, reason: audience.length ? "many" : "no-class" });
  const cls = await Class.findById(targetId);
  if (!cls) return res.json({ joined: false, reason: "no-class" });

  const existing = await Enrollment.findOne({ student: req.user._id, class: cls._id });
  if (existing) {
    if (existing.status !== "approved") {
      existing.status = "approved";
      await existing.save();
    }
  } else {
    await Enrollment.create({
      student: req.user._id,
      class: cls._id,
      teacher: cls.owner,
      status: "approved",
    });
    notifyEnrollment(cls, req.user, false);
  }
  res.json({ joined: true, className: cls.name || "" });
});

// GET /api/materials/share/:token/file — the file itself.
const getSharedFile = asyncHandler(async (req, res) => {
  const material = await loadShared(req, res);
  if (!material) return;
  if (material.share.requireAuth) {
    if (!req.user) {
      res.status(401);
      throw new Error("Bu materialı oxumaq üçün daxil olun");
    }
    // Same rule as the metadata call — being signed in is not enough.
    if (!(await canAccess(req.user, material))) {
      res.status(403);
      throw new Error("Bu material müəllimin sinfindəki şagirdlər üçündür");
    }
  }
  const abs = path.join(MATERIALS_DIR, material.fileName);
  if (!abs.startsWith(MATERIALS_DIR) || !fs.existsSync(abs)) {
    res.status(404);
    throw new Error("Fayl tapılmadı");
  }
  // Range requests only ever arrive as follow-ups to a read that was already
  // counted, so counting them again would multiply one reader into dozens.
  if (!req.headers.range) {
    noteRead(material, req.user).catch((e) => console.error("share read log:", e?.message));
  }
  res.sendFile(abs, {
    acceptRanges: true,
    headers: {
      "Content-Type": material.mimeType || "application/octet-stream",
      "Content-Disposition": "inline",
      "Cache-Control": "private, max-age=0, must-revalidate",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

module.exports = {
  setMaterialShare,
  joinFromShare,
  getSharedMaterial,
  getSharedFile,
  getMaterials,
  addMaterial,
  viewMaterial,
  downloadMaterial,
  updateMaterial,
  deleteMaterial,
  MATERIALS_DIR,
};
