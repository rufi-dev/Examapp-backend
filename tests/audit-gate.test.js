/*
 * CR-111/CR-114 — the EXACT audit gate. Fingerprint = package + severity + exact sorted
 * set of HIGH advisory ids + exact sorted set of node paths. Critical always fails; a
 * High needs an exact, unexpired, well-formed exception. Includes the two Codex
 * reproductions (nested-same-package path; a Low id authorizing an aggregated High) and
 * exercises the real ExcelJS export bounds.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const GATE = path.join(__dirname, "..", "scripts", "auditGate.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auditgate-"));

// Build a synthetic npm-audit vuln: `via` advisories carry their OWN severity, so the
// gate can filter to high-only ids. `nodes` are the exact package paths.
function vuln(sev, { advisories = [{ id: "GHSA-high-1", severity: "high" }], nodes = ["node_modules/evilpkg"] } = {}) {
  return { name: "evilpkg", severity: sev, via: advisories.map((a) => ({ source: 1, url: `https://github.com/advisories/${a.id}`, title: "x", severity: a.severity })), nodes, fixAvailable: false };
}
function auditJson(v, meta = {}) {
  return { vulnerabilities: { evilpkg: v }, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: v.severity === "high" ? 1 : 0, critical: v.severity === "critical" ? 1 : 0, total: 1, ...meta } } };
}
function runGate(audit, manifest, { rawAudit } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, "run-"));
  const aj = path.join(dir, "audit.json");
  fs.writeFileSync(aj, rawAudit != null ? rawAudit : JSON.stringify(audit));
  if (manifest) fs.writeFileSync(path.join(dir, ".audit-exceptions.json"), JSON.stringify(manifest));
  const r = spawnSync(process.execPath, [GATE], { cwd: dir, encoding: "utf8", env: { ...process.env, AUDIT_JSON: aj } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const future = "2999-01-01";
const ex = (over = {}) => ({ exceptions: [{ package: "evilpkg", severity: "high", ids: ["GHSA-high-1"], paths: ["node_modules/evilpkg"], reason: "r", owner: "o", control: "c", expires: future, ...over }] });

function excelTest() {
  const { buildResultsExcel, MAX_ROWS, MAX_CELL } = require("../helper/examReport");
  const bomb = Array.from({ length: MAX_ROWS + 800 }, (_, i) => ({ userId: { name: "X".repeat(MAX_CELL + 900), email: "e".repeat(MAX_CELL + 900), phone: "1" }, earnPoints: i }));
  return buildResultsExcel({ name: "N".repeat(MAX_CELL + 900) }, bomb, "C".repeat(MAX_CELL + 900), { n: bomb.length, total: 100, avg: 1, high: 1, low: 0, passingMarks: 50, pass: 1 })
    .then((buf) => ({ ok: Buffer.isBuffer(buf) && buf.length > 0 && buf.length < 5 * 1024 * 1024 }));
}

async function main() {
  // ── core gate ──
  ok("critical FAILS even with a matching exception (never exceptable)", runGate(auditJson(vuln("critical")), ex()).code === 1);
  ok("a high with NO manifest FAILS", runGate(auditJson(vuln("high")), null).code === 1);
  ok("a high with an EXACT, unexpired exception PASSES", runGate(auditJson(vuln("high")), ex()).code === 0);
  ok("an EXPIRED exception FAILS", runGate(auditJson(vuln("high")), ex({ expires: "2000-01-01" })).code === 1);
  ok("a missing owner/reason/control FAILS", runGate(auditJson(vuln("high")), ex({ owner: "" })).code === 1);
  ok("a moderate advisory does NOT fail the gate", runGate({ vulnerabilities: { m: { severity: "moderate", via: [{ url: "https://x/GHSA-m", source: 2, severity: "moderate" }], nodes: ["node_modules/m"] } }, metadata: { vulnerabilities: { moderate: 1, high: 0, critical: 0 } } }, null).code === 0);

  // ── Codex reproduction #1: nested SAME-package path must NOT be covered by the base path ──
  ok("REPRO-1: exception path node_modules/evilpkg does NOT authorize nested node_modules/other/node_modules/evilpkg", runGate(auditJson(vuln("high", { nodes: ["node_modules/other/node_modules/evilpkg"] })), ex()).code === 1);

  // ── Codex reproduction #2: a Low id may NOT authorize an aggregated High ──
  ok("REPRO-2: a high whose only advisory is LOW cannot be excepted by that Low id", runGate(auditJson(vuln("high", { advisories: [{ id: "GHSA-low-1", severity: "low" }] })), ex({ ids: ["GHSA-low-1"] })).code === 1);
  ok("REPRO-2b: even with NO id cited, the low-only high is not authorized", runGate(auditJson(vuln("high", { advisories: [{ id: "GHSA-low-1", severity: "low" }] })), ex({ ids: ["GHSA-high-1"] })).code === 1);

  // ── exactness: added/removed id or path, changed nested path, stale, severity change, malformed ──
  ok("an ADDED advisory id (vuln has 2 high ids, exception cites 1) FAILS", runGate(auditJson(vuln("high", { advisories: [{ id: "GHSA-high-1", severity: "high" }, { id: "GHSA-high-2", severity: "high" }] })), ex()).code === 1);
  ok("a PARTIAL node set (vuln has 2 paths, exception lists 1) FAILS", runGate(auditJson(vuln("high", { nodes: ["node_modules/evilpkg", "node_modules/x/node_modules/evilpkg"] })), ex()).code === 1);
  ok("an ADDED path in the exception (not in the vuln) FAILS", runGate(auditJson(vuln("high")), ex({ paths: ["node_modules/evilpkg", "node_modules/extra"] })).code === 1);
  ok("a STALE exception (matches no current vuln) FAILS", runGate({ vulnerabilities: {}, metadata: { vulnerabilities: { high: 0, critical: 0 } } }, ex()).code === 1);
  ok("a severity!=high exception FAILS", runGate(auditJson(vuln("high")), ex({ severity: "moderate" })).code === 1);
  ok("a MALFORMED audit JSON FAILS closed", runGate(null, ex(), { rawAudit: "{ not json" }).code === 1);

  // ── ExcelJS bounds (CR-114.5) ──
  const xl = await excelTest();
  ok("CR-114.5: a hostile ExcelJS dataset produces a BOUNDED buffer (rows/cells/meta capped)", xl.ok);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
