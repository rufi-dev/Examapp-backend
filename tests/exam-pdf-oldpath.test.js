/*
 * AUD-013 CR-093 — the rollback `oldPath` origin/shape validator. An absolute
 * `/uploads/` path is restored to the DB row ONLY when its origin is an EXPLICITLY
 * approved legacy API origin; a relative `/uploads/<basename>` is always allowed;
 * every attacker/look-alike origin, credential, alternate scheme, protocol-relative,
 * query/fragment, traversal/normalization and encoded-separator trick is rejected,
 * and the DECODED basename must equal the validated filename.
 */
process.env.LEGACY_UPLOADS_ORIGIN = "https://api.examopia.com";
const { validLegacyOldPath } = require("../migrations/2026-07-26-exam-pdf-private.js");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const ORIGINS = new Set(["https://api.examopia.com"]);
const v = (p, f = "rb.pdf") => validLegacyOldPath(p, f, ORIGINS);

// ── ACCEPT ──
ok("relative /uploads/<basename> accepted", v("/uploads/rb.pdf") === true);
ok("configured absolute legacy origin accepted", v("https://api.examopia.com/uploads/rb.pdf") === true);

// ── REJECT: origin ──
ok("attacker origin rejected", v("https://attacker.example/uploads/rb.pdf") === false);
ok("look-alike SUFFIX host rejected", v("https://api.examopia.com.evil.com/uploads/rb.pdf") === false);
ok("look-alike SUBDOMAIN host rejected", v("https://evil-api.examopia.com/uploads/rb.pdf") === false);
ok("bare-http of the https origin rejected (origin includes scheme)", v("http://api.examopia.com/uploads/rb.pdf") === false);
ok("embedded credentials rejected", v("https://u:p@api.examopia.com/uploads/rb.pdf") === false);
ok("non-http scheme rejected", v("file:///uploads/rb.pdf") === false);
ok("protocol-relative rejected", v("//attacker.example/uploads/rb.pdf") === false);

// ── REJECT: query/fragment ──
ok("query string rejected", v("https://api.examopia.com/uploads/rb.pdf?x=1") === false);
ok("fragment rejected", v("https://api.examopia.com/uploads/rb.pdf#x") === false);

// ── REJECT: traversal / separators / subdir ──
ok("literal ../ traversal (normalizes off /uploads) rejected", v("/uploads/../etc/rb.pdf") === false);
ok("subdirectory path rejected", v("/uploads/sub/rb.pdf") === false);
ok("encoded slash %2f rejected", v("/uploads/rb%2f..%2fetc") === false);
ok("encoded dot %2e rejected", v("/uploads/%2e%2e/rb.pdf") === false);
ok("encoded backslash %5c rejected", v("/uploads/rb%5c.pdf") === false);
ok("literal backslash rejected", v("/uploads/rb.pdf\\x") === false);
ok("whitespace rejected", v("/uploads/rb .pdf") === false);

// ── REJECT: basename mismatch / malformed / empty ──
ok("basename mismatch rejected", v("/uploads/other.pdf") === false);
ok("wrong route (not /uploads/) rejected", v("/private/rb.pdf") === false);
ok("empty string rejected", v("") === false);
ok("non-string rejected", v(null) === false);
ok("malformed URL rejected", v("http://[bad/uploads/rb.pdf") === false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
