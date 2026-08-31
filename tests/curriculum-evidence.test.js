/*
 * CR-MSO-002 / CR-MSO-003 — citation matching and citation-claim detection.
 *
 * Two properties matter most here:
 *   1. aggressive normalisation must not be able to FABRICATE a match. Folding
 *      diacritics and OCR confusions on a short string turns unrelated text into
 *      the same string, so tier 2 is gated on length and short excerpts cannot
 *      reach machine_matched at all.
 *   2. prose is never rewritten. An earlier design stripped page-like text with a
 *      regex, which would damage a legitimate question containing "kitabın 47-ci
 *      səhifəsi". Detection is advisory; the validator fails the task instead.
 */
const assert = require("assert");
const {
  VERIFY_STATUS,
  MIN_EXCERPT_CHARS,
  TIER2_MIN_CHARS,
  normalizeTier1,
  normalizeTier2,
  normalizeFor,
  matchExcerpt,
  findCitationClaims,
} = require("../helper/curriculumEvidence");

let passed = 0;
let failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name, extra === undefined ? "" : extra); }
};

console.log("\n1. Tier-1 normalisation is safe and lossless enough to trust:");
{
  ok("collapses whitespace and line breaks", normalizeTier1("Bir   iki\n\tüç") === "bir iki üç");
  ok("joins a soft-hyphenated line end", normalizeTier1("riyaziy-\nyat") === "riyaziyyat");
  ok("folds case with Azerbaijani rules", normalizeTier1("BAKI") === "bakı");
  ok("keeps diacritics (tier 1 is not lossy)", normalizeTier1("Gəncə") === "gəncə");
  ok("empty input is empty output", normalizeTier1(null) === "");
}

console.log("\n2. Tier-2 is lossy, so it is LENGTH-GATED:");
{
  const short = "rn";
  ok("tier 2 folds rn -> m", normalizeTier2("rn") === "m");
  ok("tier 2 folds diacritics", normalizeTier2("Gəncə şəhəri") === "gence seheri");
  ok("a short excerpt selects tier 1", normalizeFor(short).tier === 1);
  const long = "a".repeat(TIER2_MIN_CHARS + 5);
  ok("a long excerpt selects tier 2", normalizeFor(long).tier === 2);
  ok("the gate is above the minimum excerpt length", TIER2_MIN_CHARS > MIN_EXCERPT_CHARS);
}

console.log("\n3. Matching cannot promote a weak claim:");
{
  const page =
    "Tapşırıq 8. Düzbucaqlı paralelepipedin həcmini hesablayın: uzunluğu 5 sm, eni 3 sm, hündürlüyü 4 sm olan cismin həcmi neçə kubsantimetrdir?";

  ok(
    "an exact long excerpt matches",
    matchExcerpt(page, { excerpt: "Düzbucaqlı paralelepipedin həcmini hesablayın: uzunluğu 5 sm" }).status ===
      VERIFY_STATUS.MACHINE_MATCHED
  );
  ok(
    "a whitespace/linebreak-mangled excerpt still matches",
    matchExcerpt(page, { excerpt: "Düzbucaqlı   paralelepipedin\nhəcmini hesablayın: uzunluğu 5 sm" }).status ===
      VERIFY_STATUS.MACHINE_MATCHED
  );
  {
    const r = matchExcerpt(page, { excerpt: "həcmini" });
    ok("a SHORT excerpt can never reach machine_matched", r.status === VERIFY_STATUS.UNVERIFIED && r.reason === "excerpt_too_short", r.reason);
  }
  {
    const r = matchExcerpt(page, { excerpt: "Bu mətn bu səhifədə ümumiyyətlə yoxdur və uydurulmuşdur." });
    ok("an invented excerpt is not found", r.status === VERIFY_STATUS.UNVERIFIED && r.reason === "excerpt_not_found", r.reason);
  }
  {
    // A scan has no extractable text — machine matching is unavailable, and the
    // teacher_verified path exists precisely for this.
    const r = matchExcerpt("", { excerpt: "anything at all, quite long indeed, more than forty chars" });
    ok("a text-less scan yields no_extractable_text, not a false match", r.status === VERIFY_STATUS.UNVERIFIED && r.reason === "no_extractable_text", r.reason);
  }
}

console.log("\n4. A task number must be NEAR the excerpt, not merely on the page:");
{
  const page = "Tapşırıq 8. Birinci məsələ mətni burada uzun-uzadı davam edir və bitir.\n" + "x".repeat(3000) + "\nTapşırıq 41. Tamam başqa bir məsələ.";
  ok(
    "the nearby task number confirms",
    matchExcerpt(page, { excerpt: "Birinci məsələ mətni burada uzun-uzadı davam edir", sourceTaskNo: "8" }).status ===
      VERIFY_STATUS.MACHINE_MATCHED
  );
  const far = matchExcerpt(page, { excerpt: "Birinci məsələ mətni burada uzun-uzadı davam edir", sourceTaskNo: "41" });
  ok("a FAR task number does not confirm", far.status === VERIFY_STATUS.UNVERIFIED && far.reason === "task_no_not_near_excerpt", far.reason);
  const absent = matchExcerpt(page, { excerpt: "Birinci məsələ mətni burada uzun-uzadı davam edir", sourceTaskNo: "999" });
  ok("an invented task number does not confirm", absent.status === VERIFY_STATUS.UNVERIFIED, absent.reason);
}

console.log("\n5. Citation claims are DETECTED, never rewritten:");
{
  ok("detects 'səh. 47'", findCitationClaims("Ev tapşırığı: səh. 47, №12-15").length > 0);
  ok("detects '47-ci səhifə'", findCitationClaims("kitabın 47-ci səhifəsindən oxu").length > 0);
  ok("detects a bare task number", findCitationClaims("№8 həll edin").length > 0);
  // The false-positive class the repo's own hasMathLeak already guards against.
  ok("a plain numeric range is NOT a citation claim", findCitationClaims("20-30 arası ədədləri yaz").length === 0);
  ok("plain prose is not a claim", findCitationClaims("Kvadrat tənlikləri həll edin.").length === 0);

  // The property that matters: detection returns matches, it does not edit.
  const original = "Ev tapşırığı: səh. 47, №12-15";
  findCitationClaims(original);
  ok("the input string is untouched by detection", original === "Ev tapşırığı: səh. 47, №12-15");
  ok(
    "the module exposes no rewriting/stripping helper at all",
    (() => {
      const mod = require("../helper/curriculumEvidence");
      return !Object.keys(mod).some((k) => /strip|scrub|redact|sanitisePage|sanitizePage/i.test(k));
    })()
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} curriculum-evidence assertions failed`);
process.exit(failed ? 1 : 0);
