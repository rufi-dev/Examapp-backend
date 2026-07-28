/*
 * CR-111/CR-114 — EXACT production audit gate (CI-friendly, shared verbatim by both
 * repos). For every production vulnerability of severity high/critical it computes an
 * exact fingerprint and enforces:
 *   • critical → FAIL always (never exceptable).
 *   • high → FAIL unless a reviewed, UNEXPIRED exception matches EXACTLY:
 *       - package name identical,
 *       - the exception's sorted `ids` == the vuln's sorted set of HIGH-severity
 *         advisory ids (a Low/Moderate id can NEVER authorize a High),
 *       - the exception's sorted `paths` == the vuln's sorted set of ALL node paths
 *         (exact strings — no suffix/wildcard; a nested `a/node_modules/pkg` path is
 *         NOT covered by `node_modules/pkg`),
 *       - owner + reason + control present, expiry parseable and in the future.
 *   • any stale/unused exception, any added/removed id or path, a severity change, a
 *     malformed audit JSON, or a manifest error → FAIL.
 *   • moderate/low → reported, not gated.
 *
 *   node scripts/auditGate.cjs                     # gate this repo (cwd)
 *   AUDIT_JSON=<file> node scripts/auditGate.cjs   # gate a captured audit JSON (tests)
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, ".audit-exceptions.json");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sortU = (arr) => [...new Set(arr.map(String))].sort();

function loadAudit() {
  let raw;
  if (process.env.AUDIT_JSON) raw = fs.readFileSync(process.env.AUDIT_JSON, "utf8");
  else {
    try { raw = execSync("npm audit --omit=dev --json", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch (e) { if (e.stdout) raw = e.stdout.toString(); else throw e; }
  }
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error("MALFORMED_AUDIT_JSON"); }
  if (!j || typeof j !== "object" || typeof j.vulnerabilities !== "object") throw new Error("MALFORMED_AUDIT_JSON");
  return j;
}

function loadExceptions(now) {
  if (!fs.existsSync(MANIFEST)) return { list: [], errors: [] };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return { list: [], errors: ["manifest is not valid JSON"] }; }
  const errors = [];
  const list = (raw.exceptions || []).map((x, i) => {
    for (const f of ["package", "reason", "owner", "control", "expires"]) {
      if (!x[f] || String(x[f]).trim() === "") errors.push(`exception[${i}] missing "${f}"`);
    }
    if (!Array.isArray(x.ids) || x.ids.length === 0) errors.push(`exception[${i}] (${x.package}) missing "ids" array`);
    if (!Array.isArray(x.paths) || x.paths.length === 0) errors.push(`exception[${i}] (${x.package}) missing "paths" array`);
    if (x.severity && x.severity !== "high") errors.push(`exception[${i}] (${x.package}) severity must be "high"`);
    const exp = Date.parse(x.expires);
    if (Number.isNaN(exp)) errors.push(`exception[${i}] (${x.package}) unparseable expiry`);
    else if (exp < now) errors.push(`exception[${i}] (${x.package}) EXPIRED ${x.expires}`);
    return { ...x, ids: sortU(x.ids || []), paths: sortU(x.paths || []) };
  });
  return { list, errors };
}

// The EXACT set of HIGH-severity advisory ids affecting one vulnerability node — walk
// the recursive `via` graph but keep ONLY advisories whose own severity is high (a Low
// or Moderate advisory can never authorize a High). Returns sorted GHSA ids.
function highAdvisoryIds(vuln, all) {
  const ids = new Set();
  const seen = new Set();
  const walk = (v) => {
    for (const via of v.via || []) {
      if (typeof via === "string") { if (all[via] && !seen.has(via)) { seen.add(via); walk(all[via]); } }
      else if (via && (via.severity === "high" || via.severity === "critical")) {
        const id = via.url ? String(via.url).split("/").pop() : (via.source != null ? String(via.source) : null);
        if (id) ids.add(id);
      }
    }
  };
  walk(vuln);
  return sortU([...ids]);
}

function main() {
  const now = Date.now();
  let audit;
  try { audit = loadAudit(); } catch (e) { console.log(`  ✗ ${e.message}`); console.log("\nAUDIT GATE FAILED (1)"); process.exit(1); }
  const vulns = audit.vulnerabilities || {};
  const { list: exceptions, errors: manifestErrors } = loadExceptions(now);
  const failures = [...manifestErrors];
  const allowed = [];
  const usedException = new Set();

  for (const [pkg, v] of Object.entries(vulns)) {
    if (v.severity !== "high" && v.severity !== "critical") continue;
    if (v.severity === "critical") { failures.push(`CRITICAL ${pkg} (never exceptable)`); continue; }
    const ids = highAdvisoryIds(v, vulns);
    const paths = sortU((v.nodes || []).map(String));
    const idx = exceptions.findIndex((x) => x.package === pkg && eq(x.ids, ids) && eq(x.paths, paths));
    if (idx >= 0 && !usedException.has(idx)) { usedException.add(idx); allowed.push(`HIGH ${pkg} [${ids.join(",")}] excepted → ${exceptions[idx].owner}, expires ${exceptions[idx].expires}`); }
    else failures.push(`HIGH ${pkg} has NO EXACT unexpired exception (ids=[${ids.join(",")}] paths=[${paths.join(",")}])`);
  }
  // A manifest entry that matches no current vulnerability is stale → fail.
  exceptions.forEach((x, i) => { if (!usedException.has(i)) failures.push(`STALE exception (${x.package}) matches no current vulnerability`); });

  const meta = (audit.metadata && audit.metadata.vulnerabilities) || {};
  console.log(`audit gate: ${JSON.stringify(meta)}`);
  allowed.forEach((a) => console.log("  · allowed:", a));
  if (failures.length) {
    failures.forEach((f) => console.log("  ✗", f));
    console.log(`\nAUDIT GATE FAILED (${failures.length})`);
    process.exit(1);
  }
  console.log("\nAUDIT GATE PASSED");
  process.exit(0);
}
main();
