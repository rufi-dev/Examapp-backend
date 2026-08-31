/*
 * Curriculum sources: upload, page mapping, page selection, server-rendered crop
 * evidence, and reference-checked deletion.
 *
 * Every byte a citation pins lives in the private, immutable store
 * (helper/curriculumStorage.js), never in materials/. Every crop and every page
 * text comes from THOSE bytes — the browser only ever proposes coordinates.
 */
const asyncHandler = require("express-async-handler");
const fsp = require("fs").promises;
const mongoose = require("mongoose");
const path = require("path");

const CurriculumSource = require("../models/curriculumSourceModel");
const CurriculumSourceVersion = require("../models/curriculumSourceVersionModel");
const SourceReference = require("../models/sourceReferenceModel");
const storage = require("../helper/curriculumStorage");
const geometry = require("../helper/curriculumGeometry");
const evidence = require("../helper/curriculumEvidence");
const { claimDeletion, finishDeletion, syncRefCount } = require("../services/curriculumSourceService");
const { httpError } = require("../utils/appError");
const { validateUploadFile } = require("../utils/fileValidation");

const MAX_SOURCE_MB = Number(process.env.CURRICULUM_MAX_MB) || 200;
const MAX_SELECTED_PAGES = Number(process.env.CURRICULUM_MAX_PAGES) || 60;

const ownsOrAdmin = (user, doc) =>
  user && (String(doc.owner) === String(user._id) || user.role === "admin");

const mine = async (req, id) => {
  const src = await CurriculumSource.findById(id);
  if (!src) throw httpError(404, "source_missing", "Dərslik mənbəyi tapılmadı.");
  if (!ownsOrAdmin(req.user, src)) throw httpError(403, "not_owner", "Bu mənbə sizə aid deyil.");
  return src;
};

// GET /api/curriculum/sources
const listSources = asyncHandler(async (req, res) => {
  const sources = await CurriculumSource.find({ owner: req.user._id, archivedAt: null })
    .sort({ createdAt: -1 })
    .lean();
  const ids = sources.map((s) => s._id);
  const versions = await CurriculumSourceVersion.find({ source: { $in: ids }, state: { $ne: "deleting" } })
    .select("source versionNumber state pageCount bytes sha256 readyAt")
    .lean();
  const bySource = new Map();
  for (const v of versions) {
    if (!bySource.has(String(v.source))) bySource.set(String(v.source), []);
    bySource.get(String(v.source)).push(v);
  }
  res.json({
    sources: sources.map((s) => ({ ...s, versions: bySource.get(String(s._id)) || [] })),
  });
});

/*
 * POST /api/curriculum/sources — upload a chapter.
 *
 * The hash is taken at staged -> ready, AFTER the last byte-mutating step. Nothing
 * ever rewrites a `ready` file, which is the property materials/ cannot offer.
 */
const createSource = asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw httpError(400, "file_required", "PDF faylı lazımdır.");
  const bytes = file.size || (file.buffer ? file.buffer.length : 0);
  if (bytes > MAX_SOURCE_MB * 1024 * 1024) {
    throw httpError(413, "file_too_large", `Fayl çox böyükdür (maksimum ${MAX_SOURCE_MB}MB).`);
  }

  storage.preflight();
  const key = storage.newKey();
  const ext = path.extname(file.originalname || "").toLowerCase() === ".pdf" ? ".pdf" : ".pdf";
  const staged = storage.stagingPathFor(key, ext);
  await fsp.writeFile(staged, file.buffer);

  // Magic bytes, from the file we actually stored — never the client's MIME.
  const check = await validateUploadFile(staged, ext);
  if (!check || !check.ok) {
    await fsp.unlink(staged).catch(() => {});
    throw httpError(400, "file_type_invalid", "Yalnız həqiqi PDF faylı qəbul olunur.");
  }

  const source = await CurriculumSource.create({
    owner: req.user._id,
    title: String(req.body.title || file.originalname || "Dərslik").slice(0, 300),
    subject: String(req.body.subject || "").slice(0, 120),
    grade: String(req.body.grade || "").slice(0, 40),
    textbookEdition: String(req.body.textbookEdition || "").slice(0, 200),
  });

  const last = await CurriculumSourceVersion.findOne({ source: source._id }).sort({ versionNumber: -1 }).lean();
  const version = await CurriculumSourceVersion.create({
    source: source._id,
    versionNumber: last ? last.versionNumber + 1 : 1,
    storageKey: key,
    ext,
    state: "staged",
    mime: "application/pdf",
  });

  try {
    const committed = await storage.commitStaged(key, ext, staged);
    const pageCount = await evidence.pdfPageCount(committed.path);
    version.sha256 = committed.sha256;
    version.bytes = committed.bytes;
    version.pageCount = pageCount;
    version.state = "ready";
    version.readyAt = new Date();
    await version.save();
    source.activeVersion = version._id;
    source.activeVersionNumber = version.versionNumber;
    await source.save();
  } catch (e) {
    await CurriculumSourceVersion.deleteOne({ _id: version._id });
    await CurriculumSource.deleteOne({ _id: source._id });
    await fsp.unlink(staged).catch(() => {});
    throw httpError(422, "source_unreadable", "Fayl oxunmadı — PDF zədəli ola bilər.");
  }

  res.status(201).json({ source, version });
});

/*
 * PATCH /api/curriculum/sources/:id/versions/:vid/page-map
 * The teacher confirms a handful of anchors; ranges interpolate between them and
 * any page can be overridden. No model is ever asked to guess an offset.
 */
const setPageMap = asyncHandler(async (req, res) => {
  const src = await mine(req, req.params.id);
  const version = await CurriculumSourceVersion.findOne({ _id: req.params.vid, source: src._id });
  if (!version) throw httpError(404, "version_missing", "Fayl versiyası tapılmadı.");

  const map = req.body && typeof req.body.pageMap === "object" ? req.body.pageMap : {};
  const check = geometry.validatePageMap(map, version.pageCount);
  if (!check.ok) throw httpError(400, "page_map_invalid", "Səhifə xəritəsi düzgün deyil.", { errors: check.errors });

  version.pageMap = map;
  await version.save();
  res.json({
    version,
    preview: [...Array(Math.min(version.pageCount, 12))].map((_, i) => ({
      filePageIndex: i,
      printedPageLabel: geometry.printedLabelFor(map, i),
    })),
  });
});

// GET .../versions/:vid/pages/:page/text — page text from the PINNED bytes.
const pageText = asyncHandler(async (req, res) => {
  const src = await mine(req, req.params.id);
  const version = await CurriculumSourceVersion.findOne({ _id: req.params.vid, source: src._id });
  if (!version) throw httpError(404, "version_missing", "Fayl versiyası tapılmadı.");
  const idx = Number(req.params.page);
  if (!Number.isSafeInteger(idx) || idx < 0 || idx >= version.pageCount) {
    throw httpError(400, "page_out_of_range", "Səhifə nömrəsi sənəddən kənardır.");
  }
  const file = storage.pathForKey(version.storageKey, version.ext);
  const text = await evidence.pdfPageText(file, idx);
  res.json({
    filePageIndex: idx,
    printedPageLabel: geometry.printedLabelFor(version.pageMap, idx),
    // "" for a scan. The client must then offer the teacher_verified path rather
    // than pretending a machine match is possible.
    text,
    hasText: Boolean(text && text.trim()),
  });
});

/*
 * POST .../versions/:vid/crop — the AUTHORITATIVE crop.
 *
 * The browser proposes { filePageIndex, cropBox } and nothing else: it never
 * uploads pixels, because a modified client could otherwise attach an unrelated
 * image and the citation would be worthless.
 */
const renderCrop = asyncHandler(async (req, res) => {
  const src = await mine(req, req.params.id);
  const version = await CurriculumSourceVersion.findOne({ _id: req.params.vid, source: src._id });
  if (!version) throw httpError(404, "version_missing", "Fayl versiyası tapılmadı.");

  const file = storage.pathForKey(version.storageKey, version.ext);
  // Corruption or substitution of the pinned bytes is the ONLY thing that may
  // invalidate a citation — so check before producing evidence from them.
  const intact = await storage.verifyBytes(version.storageKey, version.ext, version.sha256);
  if (!intact.ok) throw httpError(409, "source_bytes_changed", "Mənbə faylı dəyişib və ya itib.");

  const filePageIndex = Number(req.body.filePageIndex);
  const geo = await evidence.pdfPageGeometry(file, filePageIndex);
  let out;
  try {
    out = await evidence.renderCrop(file, {
      filePageIndex,
      cropBox: req.body.cropBox,
      pageCount: version.pageCount,
      geometry: geo,
    });
  } catch (e) {
    if (e.cropCode) throw httpError(400, e.cropCode, "Seçilmiş sahə düzgün deyil.", { reason: e.cropCode });
    throw e;
  }

  const cropKey = storage.newKey();
  await fsp.writeFile(storage.pathForKey(cropKey, ".png"), out.buffer);
  // Record it against the version so the asset route can resolve an owner.
  await CurriculumSourceVersion.updateOne({ _id: version._id }, { $addToSet: { cropKeys: cropKey } });

  res.status(201).json({
    cropAssetKey: cropKey,
    cropHash: out.cropHash,
    widthPx: out.widthPx,
    heightPx: out.heightPx,
    // The evidence binds source + hash + page + box + crop hash, so the crop is
    // reproducible from the source and any substitution is detectable.
    evidence: {
      source: src._id,
      sourceVersion: version._id,
      sourceHash: version.sha256,
      filePageIndex,
      printedPageLabel: geometry.printedLabelFor(version.pageMap, filePageIndex),
      cropBox: req.body.cropBox,
      cropAssetKey: cropKey,
      cropHash: out.cropHash,
      verifyStatus: evidence.VERIFY_STATUS.UNVERIFIED,
    },
  });
});

// POST .../versions/:vid/verify — machine-match one claimed citation.
const verifyCitation = asyncHandler(async (req, res) => {
  const src = await mine(req, req.params.id);
  const version = await CurriculumSourceVersion.findOne({ _id: req.params.vid, source: src._id });
  if (!version) throw httpError(404, "version_missing", "Fayl versiyası tapılmadı.");

  const filePageIndex = Number(req.body.filePageIndex);
  if (!Number.isSafeInteger(filePageIndex) || filePageIndex < 0 || filePageIndex >= version.pageCount) {
    throw httpError(400, "page_out_of_range", "Səhifə nömrəsi sənəddən kənardır.");
  }
  const file = storage.pathForKey(version.storageKey, version.ext);
  const text = await evidence.pdfPageText(file, filePageIndex);
  const match = evidence.matchExcerpt(text, {
    excerpt: req.body.excerpt,
    sourceTaskNo: req.body.sourceTaskNo,
  });
  res.json({
    verifyStatus: match.status,
    reason: match.reason,
    tier: match.tier || null,
    printedPageLabel: geometry.printedLabelFor(version.pageMap, filePageIndex),
    // A scan cannot be machine-matched; the client must offer teacher confirmation
    // against the rendered crop instead. That is a two-second check, not a dead end.
    teacherVerificationAvailable: true,
  });
});

// GET /api/curriculum/assets/:key — private, owner-checked, no caching.
const getAsset = asyncHandler(async (req, res) => {
  const key = String(req.params.key || "");
  if (!storage.isValidKey(key)) throw httpError(404, "not_found", "Tapılmadı.");
  // Source bytes AND page crops both resolve to a version, so both have an owner.
  // An unknown key is a 404 — never a fallback that serves the file anyway.
  const version = await CurriculumSourceVersion.findOne({
    $or: [{ storageKey: key }, { cropKeys: key }],
  }).lean();
  if (!version) throw httpError(404, "not_found", "Tapılmadı.");
  const src = await CurriculumSource.findById(version.source).select("owner").lean();
  const ownerId = src && src.owner;
  if (!ownerId || !(req.user && (String(ownerId) === String(req.user._id) || req.user.role === "admin"))) {
    // Opaque 404, not 403: a 403 would confirm the asset exists.
    throw httpError(404, "not_found", "Tapılmadı.");
  }
  const isCrop = version.storageKey !== key;
  const ext = isCrop ? ".png" : version.ext;
  const file = storage.pathForKey(key, ext);
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(file, { acceptRanges: true }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ message: "Tapılmadı." });
  });
});

/*
 * DELETE .../versions/:vid — reference-checked and fenced.
 *
 * The reference collection is the authority, not the cached refCount. The unlink
 * happens only AFTER the claim transaction commits (the filesystem is not
 * transactional), and on unlink failure the row is RETAINED so the locator is
 * never lost.
 */
const deleteVersion = asyncHandler(async (req, res) => {
  const src = await mine(req, req.params.id);
  const version = await CurriculumSourceVersion.findOne({ _id: req.params.vid, source: src._id });
  if (!version) throw httpError(404, "version_missing", "Fayl versiyası tapılmadı.");

  const claim = await claimDeletion(version._id);
  const token = claim.deleteToken || claim.version.deleteToken;
  // Derived crops die WITH their source version — they are evidence about these
  // exact bytes and mean nothing once the bytes are gone. Best-effort: a leftover
  // crop is harmless, a lost source locator is not.
  for (const ck of version.cropKeys || []) {
    await fsp.unlink(storage.pathForKey(ck, ".png")).catch(() => {});
  }
  try {
    await fsp.unlink(storage.pathForKey(version.storageKey, version.ext));
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[CURRICULUM] unlink failed, retaining row:", version.storageKey, e.message);
      return res.status(500).json({ code: "delete_retained", message: "Fayl silinmədi; qeyd saxlanıldı." });
    }
  }
  await finishDeletion(version._id, token);
  await syncRefCount(src._id);
  res.json({ deleted: true });
});

// GET .../versions/:vid/holders — who is blocking a delete, and why.
const versionHolders = asyncHandler(async (req, res) => {
  const src = await mine(req, req.params.id);
  const holders = await SourceReference.find({ sourceVersion: req.params.vid }).lean();
  res.json({
    source: src._id,
    holders: holders.map((h) => ({ kind: h.holderKind, id: h.holderId, label: h.holderLabel })),
  });
});

module.exports = {
  MAX_SOURCE_MB,
  MAX_SELECTED_PAGES,
  listSources,
  createSource,
  setPageMap,
  pageText,
  renderCrop,
  verifyCitation,
  getAsset,
  deleteVersion,
  versionHolders,
};
