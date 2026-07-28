/*
 * AUD-013 CR-067 — the PRIVATE exam-PDF store is configuration-driven and its
 * startup preflight refuses an ephemeral (non-absolute) production directory,
 * proves writability, and a written PDF survives a process restart pointed at
 * the same directory (the persistent-volume contract at unit level).
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const STORAGE = require.resolve("../helper/examPdfStorage");
// Load the module fresh under a chosen env (it resolves dirs at load time).
function loadWith(env) {
  delete require.cache[STORAGE];
  const saved = { NODE_ENV: process.env.NODE_ENV, EXAM_PDF_DIR: process.env.EXAM_PDF_DIR, PDF_STAGING_DIR: process.env.PDF_STAGING_DIR };
  Object.assign(process.env, env);
  for (const k of ["NODE_ENV", "EXAM_PDF_DIR", "PDF_STAGING_DIR"]) if (!(k in env)) delete process.env[k];
  const mod = require("../helper/examPdfStorage");
  Object.assign(process.env, saved);
  return mod;
}
const rejects = async (p) => { try { await p; return false; } catch { return true; } };

async function main() {
  const priv = fs.mkdtempSync(path.join(os.tmpdir(), "cr067-priv-"));
  const stg = fs.mkdtempSync(path.join(os.tmpdir(), "cr067-stg-"));

  // ── preflight: production REFUSES a relative (ephemeral container-layer) dir ──
  const prodRel = loadWith({ NODE_ENV: "test", EXAM_PDF_DIR: priv, PDF_STAGING_DIR: stg });
  ok("production + relative EXAM_PDF_DIR → preflight throws (ephemeral refused)", await rejects(prodRel.preflight({ env: "production", explicitDir: "examPdfs" })));
  ok("production + unset EXAM_PDF_DIR → preflight throws", await rejects(prodRel.preflight({ env: "production", explicitDir: undefined })));

  // ── preflight: production ACCEPTS an absolute dir + proves writability ──
  const prodAbs = loadWith({ NODE_ENV: "test", EXAM_PDF_DIR: priv, PDF_STAGING_DIR: stg });
  const pf = await prodAbs.preflight({ env: "production", explicitDir: priv });
  ok("production + absolute EXAM_PDF_DIR → preflight ok", pf.writable === true && pf.examPdfDir === path.resolve(priv));

  // ── development may use the relative default ──
  const dev = loadWith({ NODE_ENV: "development", EXAM_PDF_DIR: priv, PDF_STAGING_DIR: stg });
  ok("development preflight ok", (await dev.preflight()).writable === true);

  // ── config-driven paths + traversal-safe staging ──
  const m = loadWith({ NODE_ENV: "test", EXAM_PDF_DIR: priv, PDF_STAGING_DIR: stg });
  ok("EXAM_PDF_DIR/PDF_STAGING_DIR resolve to the configured absolute dirs", m.EXAM_PDF_DIR === path.resolve(priv) && m.PDF_STAGING_DIR === path.resolve(stg));
  ok("stagingPathFor keeps a traversal name INSIDE the staging dir", path.dirname(m.stagingPathFor("../../etc/passwd")) === path.resolve(stg));
  ok("pathForKey refuses a non-key", m.pathForKey("not-a-key") === null);

  // ── restart persistence: a written PDF is still readable after a fresh load ──
  const key = m.newKey();
  fs.writeFileSync(m.pathForKey(key), Buffer.from("%PDF-1.7\n%%EOF\n"));
  const m2 = loadWith({ NODE_ENV: "test", EXAM_PDF_DIR: priv, PDF_STAGING_DIR: stg }); // simulates process restart, same volume
  ok("a written private PDF survives a restart pointed at the same dir", fs.existsSync(m2.pathForKey(key)) && m2.pathForKey(key) === m.pathForKey(key));

  for (const d of [priv, stg]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
