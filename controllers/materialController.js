const asyncHandler = require("express-async-handler");
const fs = require("fs");
const path = require("path");
const Material = require("../models/materialModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
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

module.exports = {
  getMaterials,
  addMaterial,
  viewMaterial,
  downloadMaterial,
  updateMaterial,
  deleteMaterial,
  MATERIALS_DIR,
};
