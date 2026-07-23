const asyncHandler = require("express-async-handler");
const fs = require("fs");
const path = require("path");
const Material = require("../models/materialModel");
const Class = require("../models/classModel");
const Enrollment = require("../models/enrollmentModel");
const { notifyEnrollment } = require("../helper/telegram");
const { convertOfficeToPdf, isOfficeFile } = require("../utils/officeToPdf");
const { enqueueConversion } = require("../utils/convertQueue");

// Office documents are capped tighter than PDFs: every one of them costs a
// LibreOffice process, not just disk.
const OFFICE_MAX_BYTES = Number(process.env.OFFICE_MAX_BYTES || 100 * 1024 * 1024);

// PRIVATE storage — deliberately NOT under uploads/, which express.static
// serves publicly. Nothing here is reachable without passing the access check
// in this controller.
const MATERIALS_DIR = path.join(process.cwd(), "materials");
if (!fs.existsSync(MATERIALS_DIR)) fs.mkdirSync(MATERIALS_DIR, { recursive: true });

const { execFile } = require("child_process");

// Web-optimise (linearize) a PDF IN PLACE so pdf.js can paint page 1 from the
// first bytes over an HTTP range request, instead of downloading the whole file
// first (a 150MB test bank otherwise showed only a progress bar until every byte
// landed). qpdf writes a reordered copy with a linearization hint table into a
// temp file, then atomically replaces the original. Best-effort: on ANY failure
// the original is left untouched. qpdf exits 3 on warnings but still produces a
// valid file, so only a real error or a missing/empty output aborts the swap.
const linearizePdf = (abs) =>
  new Promise((resolve) => {
    const tmp = `${abs}.lin.tmp`;
    execFile("qpdf", ["--linearize", "--", abs, tmp], { timeout: 240000 }, (err) => {
      try {
        const ok = !err || err.code === 3;
        if (!ok || !fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
          return resolve(false);
        }
        fs.renameSync(tmp, abs); // atomic on the same filesystem
        resolve(true);
      } catch {
        try {
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        resolve(false);
      }
    });
  });

// ───────────────────── server-side page rendering ─────────────────────
//
// Large scanned PDFs (100–200MB textbook banks) open in ~15s through pdf.js: it
// issues DOZENS of serial cross-origin range requests just to load the file
// structure — a pdf.js limitation the browser's native viewer sidesteps by
// parallelising them (HTTP/2, no CORS preflights). We can't parallelise inside
// pdf.js. So for big files we don't ship the PDF to the browser at all: the
// server (which holds the file on local disk) renders each page to a JPEG with
// poppler's pdftoppm and serves small images. Page 1 shows in ~1s, nothing
// downloads in full, and it stays read-only — the reader sees images, never a
// grabbable PDF. Small PDFs still use pdf.js (crisp vector text, selectable).
const os = require("os");
const crypto = require("crypto");

// Above this size a PDF is shown as page images instead of streamed to pdf.js.
// ~12MB: comfortably below the point where pdf.js's serial range requests get
// slow, well above ordinary worksheets that render crisply as vectors.
const IMG_MODE_MIN_BYTES = Number(process.env.IMG_MODE_MIN_BYTES || 12 * 1024 * 1024);

// Rendered page images are cached here (one dir per material). Kept out of the
// materials root's own listing logic; wiped when the material is deleted.
const PAGE_CACHE_DIR = path.join(MATERIALS_DIR, ".pagecache");

// A fixed ladder of render widths so the on-disk cache can't grow unbounded (a
// handful of entries per page, not one per pixel). The client asks for the
// smallest rung that covers its device pixels; pdftoppm scales to that width.
const RENDER_WIDTHS = [720, 1080, 1440, 1800, 2400, 3000];
const snapWidth = (w) => {
  const n = Number(w);
  if (!Number.isFinite(n)) return 1440;
  return RENDER_WIDTHS.find((x) => x >= n) || RENDER_WIDTHS[RENDER_WIDTHS.length - 1];
};

// Page images are authorised by a short-lived signed token, NOT the session
// header — an <img> tag can't send an Authorization header. The metadata call
// (which DOES run the full access check) mints the token; the image route only
// verifies it. Same trust model as a signed CDN URL: a leaked token exposes one
// material's pages for a few hours, nothing about the account. The material id
// lives inside the signed payload, so a shared image URL still carries no id.
const IMG_SECRET = process.env.JWT_SECRET || "";
const signImg = (id, ttlMs) => {
  const exp = Date.now() + ttlMs;
  const body = `${id}.${exp}`;
  const mac = crypto.createHmac("sha256", IMG_SECRET).update(body).digest("base64url");
  return `${Buffer.from(String(id)).toString("base64url")}.${exp}.${mac}`;
};
const verifyImg = (token) => {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [idB64, exp, mac] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return null;
  let id;
  try {
    id = Buffer.from(idB64, "base64url").toString();
  } catch {
    return null;
  }
  const good = crypto.createHmac("sha256", IMG_SECRET).update(`${id}.${exp}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(good);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
};

// pdfinfo → page count. Throws if poppler is missing so callers can fall back to
// pdf.js instead of pretending a 0-page document.
const pdfPageCount = (abs) =>
  new Promise((resolve, reject) => {
    execFile("pdfinfo", [abs], { timeout: 60000 }, (err, stdout) => {
      if (err) return reject(err);
      const m = /^Pages:\s+(\d+)/m.exec(stdout || "");
      resolve(m ? Number(m[1]) : 0);
    });
  });

// Small render pool + per-file dedupe: a scroll can request several pages at
// once and two readers can hit the same page together; we never launch more
// than a couple of pdftoppm processes, and identical (page,width) renders share
// one job instead of racing to write the same cache file.
const MAX_RENDER = Math.max(2, Math.min(4, (os.cpus()?.length || 2) - 1));
let renderActive = 0;
const renderQueue = [];
const acquireRender = () =>
  new Promise((resolve) => {
    if (renderActive < MAX_RENDER) {
      renderActive++;
      resolve();
    } else {
      renderQueue.push(resolve);
    }
  });
const releaseRender = () => {
  renderActive = Math.max(0, renderActive - 1);
  const next = renderQueue.shift();
  if (next) {
    renderActive++;
    next();
  }
};
const inflightRenders = new Map();

const pageCachePath = (id, n, w) =>
  path.join(PAGE_CACHE_DIR, String(id), `p${n}_w${w}.jpg`);

// Render page `n` of `abs` to a width-`w` JPEG, cached on disk. Returns the file
// path. Concurrent identical requests share one render; the result is reused
// forever (a page's pixels never change — the file is immutable once uploaded).
async function renderPage(abs, id, n, w) {
  const out = pageCachePath(id, n, w);
  if (fs.existsSync(out)) return out;
  if (inflightRenders.has(out)) return inflightRenders.get(out);

  const job = (async () => {
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    if (fs.existsSync(out)) return out; // another request finished while we waited
    await acquireRender();
    try {
      // pdftoppm's -singlefile writes "<prefix>.jpg". Render to a unique temp
      // prefix, then atomically rename into place so a killed process can never
      // leave a half-written image in the cache.
      const prefix = path.join(
        path.dirname(out),
        `tmp_${n}_${w}_${process.pid}_${Date.now()}_${Math.round(Math.random() * 1e6)}`
      );
      const tmp = `${prefix}.jpg`;
      await new Promise((resolve, reject) => {
        execFile(
          "pdftoppm",
          [
            "-jpeg",
            "-jpegopt", "quality=82",
            "-f", String(n),
            "-l", String(n),
            "-scale-to-x", String(w),
            "-scale-to-y", "-1", // -1 = keep aspect ratio from the width
            "-singlefile",
            abs,
            prefix,
          ],
          { timeout: 90000 },
          (err) => (err ? reject(err) : resolve())
        );
      });
      if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
        try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw new Error("pdftoppm produced no output");
      }
      fs.renameSync(tmp, out);
      return out;
    } finally {
      releaseRender();
    }
  })().finally(() => inflightRenders.delete(out));

  inflightRenders.set(out, job);
  return job;
}

// Best-effort: drop a material's rendered-page cache (on delete).
function purgePageCache(id) {
  try {
    fs.rmSync(path.join(PAGE_CACHE_DIR, String(id)), { recursive: true, force: true });
  } catch {
    /* non-fatal */
  }
}

// Decide how the client should view this material and, for image mode, mint the
// signed token its <img> tags will carry. `blob` = image file (unchanged path);
// `pdf` = stream to pdf.js (small/vector PDFs); `image` = server-rendered pages.
async function pagesPayload(material, abs) {
  if (material.kind !== "pdf") return { mode: "blob" };

  let pages = material.pageCount || 0;
  if (!pages) {
    try {
      pages = await pdfPageCount(abs);
      if (pages) Material.updateOne({ _id: material._id }, { pageCount: pages }).catch(() => {});
    } catch {
      // poppler unavailable / unreadable PDF → let pdf.js try.
      return { mode: "pdf" };
    }
  }

  const useImages = pages > 0 && (material.sizeBytes || 0) > IMG_MODE_MIN_BYTES;
  if (!useImages) return { mode: "pdf" };

  // Warm the first page so the very first open paints immediately.
  renderPage(abs, material._id, 1, 1440).catch(() => {});
  return { mode: "image", pages, token: signImg(material._id, 6 * 60 * 60 * 1000) };
}

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

  // Quota is checked BEFORE anything expensive happens: multer has already
  // written the file (it streams to disk as it arrives), but nothing has been
  // converted or recorded yet, so rejecting here costs only the delete.
  if (req.quotaRejected) {
    cleanup(file.path);
    return res.status(413).json({ message: req.quotaRejected.message });
  }

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
    // Conversion is the expensive path: a headless LibreOffice process for up
    // to two minutes. A tighter cap than the 200MB for plain PDFs, because the
    // cost here is CPU and wall-clock, not just disk.
    if (Number(file.size || 0) > OFFICE_MAX_BYTES) {
      cleanup(file.path);
      return res.status(413).json({
        message: `Word/PowerPoint faylı ${Math.round(
          OFFICE_MAX_BYTES / (1024 * 1024)
        )}MB-dan böyük ola bilməz. PDF kimi yükləyin.`,
      });
    }
    try {
      // One conversion at a time, and one per teacher — see utils/convertQueue.
      const pdfPath = await enqueueConversion(req.user._id, () =>
        convertOfficeToPdf(file.path, MATERIALS_DIR)
      );
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

  // Web-optimise the PDF in the BACKGROUND so the reader opens on page 1 straight
  // away (range-streamed) instead of waiting for the whole file. Does not block
  // the upload response; the material is fully usable meanwhile.
  if (kind === "pdf") {
    const abs = path.join(MATERIALS_DIR, path.basename(storedPath));
    linearizePdf(abs)
      .then((done) => {
        if (done) {
          Material.updateOne({ _id: material._id }, { sizeBytes: fs.statSync(abs).size }).catch(() => {});
        } else {
          console.warn("material linearize skipped:", material._id.toString());
        }
      })
      .catch((e) => console.warn("material linearize error:", e?.message))
      // Record the page count now (the image viewer needs it up front) and, for
      // a big file, pre-render page 1 so the first open is instant. Best-effort:
      // a missing poppler just means the reader falls back to pdf.js later.
      .finally(() => {
        pdfPageCount(abs)
          .then((pages) => {
            if (pages) Material.updateOne({ _id: material._id }, { pageCount: pages }).catch(() => {});
            if (pages && sizeBytes > IMG_MODE_MIN_BYTES) {
              renderPage(abs, material._id, 1, 1440).catch(() => {});
            }
          })
          .catch(() => {});
      });
  }

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
  purgePageCache(material._id); // drop any rendered page images
  await material.deleteOne();
  res.json({ id: req.params.id });
});

// ───────────────────────── public share links ─────────────────────────
//
// A share link carries its own secret. The material id never appears in it, so
// a leaked link exposes exactly one material and nothing about the account
// behind it. Turning sharing off closes the link at once but keeps the token,
// so switching it back on does not break a link already handed out.
// (crypto is required at the top of this file.)

const shareUrl = (token) =>
  `${(process.env.FRONTEND_URL || "").replace(/\/$/, "")}/m/${token}`;

// Which class a gated link joins: the teacher's pick, else the first class the
// material is shared with.
//
// Falling back to the FIRST rather than refusing unless there is exactly one:
// a material shared with two classes is ordinary, and refusing left the link
// unable to join anyone at all — including every link created before the
// picker existed. A default the teacher can see and change in the dialog beats
// a link that silently does nothing.
const joinTargetId = (m) => {
  if (m.share?.joinClass) return m.share.joinClass;
  const audience = audienceOf(m);
  return audience.length ? audience[0] : null;
};

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
  // Not picked: default to the first class it is shared with, so a gated link
  // always joins somewhere. The dialog shows which, and the teacher can change it.
  if (requireAuth && !joinClass) joinClass = joinTargetId(material);

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
    const targetId = joinTargetId(material);
    if (targetId) {
      const target = await Class.findById(targetId)
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

  const targetId = joinTargetId(material);
  if (!targetId) return res.json({ joined: false, reason: "no-class" });
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

// GET /api/materials/:id/pages — in-app viewer asks how to render this PDF and,
// for image mode, gets the count + signed token its <img> tags will use.
const getMaterialPages = asyncHandler(async (req, res) => {
  const loaded = await loadForRead(req, res);
  if (!loaded) return;
  res.json(await pagesPayload(loaded.material, loaded.abs));
});

// GET /api/materials/share/:token/pages — same, for a public share link.
const getSharedPages = asyncHandler(async (req, res) => {
  const material = await loadShared(req, res);
  if (!material) return;
  if (material.share.requireAuth) {
    if (!req.user) {
      res.status(401);
      throw new Error("Bu materialı oxumaq üçün daxil olun");
    }
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
  const payload = await pagesPayload(material, abs);
  // Image mode never fetches the /file route, so this metadata call is the one
  // place a share open can be counted (pdf/blob modes are counted by /file).
  if (payload.mode === "image") {
    noteRead(material, req.user).catch((e) => console.error("share read log:", e?.message));
  }
  res.json(payload);
});

// GET /api/materials/page/:n?t=<token>&w=<width> — one rendered page image.
// Authorised by the signed token (an <img> can't send an auth header), which
// carries the material id, so this route needs neither the session nor the
// share token and serves the in-app and shared viewers alike.
const getMaterialPageImage = asyncHandler(async (req, res) => {
  const n = parseInt(req.params.n, 10);
  const id = verifyImg(req.query.t);
  if (!id || !Number.isInteger(n) || n < 1) {
    res.status(403);
    throw new Error("Yanlış və ya vaxtı keçmiş sorğu");
  }
  const material = await Material.findById(id).select("fileName kind pageCount").lean();
  if (!material || material.kind !== "pdf") {
    res.status(404);
    throw new Error("Tapılmadı");
  }
  if (material.pageCount && n > material.pageCount) {
    res.status(404);
    throw new Error("Səhifə yoxdur");
  }
  const abs = path.join(MATERIALS_DIR, material.fileName);
  if (!abs.startsWith(MATERIALS_DIR) || !fs.existsSync(abs)) {
    res.status(404);
    throw new Error("Fayl tapılmadı");
  }
  let out;
  try {
    out = await renderPage(abs, id, n, snapWidth(req.query.w));
  } catch (e) {
    res.status(500);
    throw new Error("Səhifə göstərilə bilmədi");
  }
  res.sendFile(out, {
    headers: {
      "Content-Type": "image/jpeg",
      // A given (page,width) never changes → cache hard, but privately.
      "Cache-Control": "private, max-age=86400, immutable",
      "Content-Disposition": "inline",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});

module.exports = {
  setMaterialShare,
  joinFromShare,
  getSharedMaterial,
  getSharedFile,
  getSharedPages,
  getMaterials,
  addMaterial,
  viewMaterial,
  downloadMaterial,
  updateMaterial,
  deleteMaterial,
  getMaterialPages,
  getMaterialPageImage,
  MATERIALS_DIR,
};
