/*
 * AUD-013 CR-067/CR-076 — the disposable E2E launcher writes PDFs ONLY under a
 * run-owned OS-temp directory and, in cleanup, removes ONLY a directory it OWNS
 * (proven by an unpredictable id + an atomic ownership-marker token, the right
 * name shape, and a real non-symlink path under the temp root). An UNRELATED
 * child under the SAME temp root — the exact incident class — is REFUSED, as is a
 * tampered/missing marker. This is the local-data-loss containment.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { allocateE2EDirs, isUnderRoot, removeE2EDir, MARKER_NAME } = require("../scripts/e2eDisposable.cjs");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

function main() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cr076-root-"));

  // ── allocateE2EDirs: unique, created, marker written, strictly under root ──
  const d1 = allocateE2EDirs({ tmpRoot });
  const d2 = allocateE2EDirs({ tmpRoot });
  ok("allocates staging/private/journal under the temp root", isUnderRoot(d1.staging, tmpRoot) && isUnderRoot(d1.private, tmpRoot) && isUnderRoot(d1.root, tmpRoot));
  ok("each run gets a DISTINCT root + token", d1.root !== d2.root && d1.token !== d2.token && d1.token.length >= 32);
  ok("dirs created + ownership marker holds the token", fs.existsSync(d1.staging) && fs.existsSync(d1.private) && fs.readFileSync(path.join(d1.root, MARKER_NAME), "utf8") === d1.token);
  ok("run root name has the exq-e2e shape", /^exq-e2e-/.test(path.basename(d1.root)));

  // ── isUnderRoot: rejects escapes, prefix collisions, the root itself ──
  ok("isUnderRoot rejects the root itself", isUnderRoot(tmpRoot, tmpRoot) === false);
  ok("isUnderRoot rejects a `..` escape", isUnderRoot(path.join(tmpRoot, "..", "elsewhere"), tmpRoot) === false);
  ok("isUnderRoot rejects a prefix-collision sibling", isUnderRoot(tmpRoot + "-sibling", tmpRoot) === false);

  // ── removeE2EDir: removes an OWNED run, idempotent on repeat ──
  ok("removeE2EDir removes a run it owns", removeE2EDir(d1) === true && !fs.existsSync(d1.root));
  ok("repeated cleanup is idempotent (already gone → false, no throw)", removeE2EDir(d1) === false);

  // ── CR-076: an UNRELATED child under the SAME temp root is REFUSED ──
  // (this is the exact reproduced defect: a sibling `sentinel.pdf` was deleted).
  const unrelated = fs.mkdtempSync(path.join(tmpRoot, "unrelated-"));
  const sentinel = path.join(unrelated, "sentinel.pdf");
  fs.writeFileSync(sentinel, Buffer.from("%PDF-1.7\n%%EOF\n"));
  ok("refuses an unrelated same-temp-root child (wrong name shape)", throws(() => removeE2EDir({ root: unrelated, token: "x", tmpRoot })));
  // Give it the right NAME but no/again-wrong marker — still refused.
  const fakeRun = fs.mkdtempSync(path.join(tmpRoot, "exq-e2e-fake-"));
  fs.writeFileSync(path.join(fakeRun, "sentinel.pdf"), Buffer.from("%PDF"));
  ok("refuses a right-named dir with NO ownership marker", throws(() => removeE2EDir({ root: fakeRun, token: "whatever", tmpRoot })));
  fs.writeFileSync(path.join(fakeRun, MARKER_NAME), "not-the-token");
  ok("refuses a TAMPERED/wrong-token marker", throws(() => removeE2EDir({ root: fakeRun, token: "the-real-token", tmpRoot })));
  ok("the unrelated sentinel + fake dir are PRESERVED", fs.existsSync(sentinel) && fs.existsSync(fakeRun));

  // ── refuses a bare path / missing run object / temp-root itself ──
  ok("refuses a bare string path (needs the run object)", throws(() => removeE2EDir(d2.root)));
  ok("refuses the temp root itself", throws(() => removeE2EDir({ root: tmpRoot, token: "x", tmpRoot })));
  ok("refuses a path OUTSIDE the temp root", throws(() => removeE2EDir({ root: path.join(os.tmpdir(), "exq-e2e-outside"), token: "x", tmpRoot })));

  for (const d of [tmpRoot]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main();
