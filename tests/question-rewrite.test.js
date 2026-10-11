/* eslint-env node */
/*
 * "AI ilə düzəlt" does what the teacher asked, and says so honestly.
 *
 * 11 Oct 2026, Gülarə Sərkərova, two rewrites from her phone:
 *   Q15 "Sual dəyişsin məsələ tipində ver" → became a word problem. Right.
 *   Q17 "Eləcə fərqi sal soruş" (a typo for "fərqli sual", a different
 *       question) → the model read "fərqi" as set DIFFERENCE and turned
 *       "simmetrik fərq" into "A\B fərq" over the same sets. Only the options
 *       changed, and the page announced "Sual yeniləndi".
 */
process.env.NODE_ENV = "test";

const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
const ok = (label, cond, extra = "") => {
  if (cond) {
    passed += 1;
    console.log("  ✓", label);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", label, extra ? `- ${extra}` : "");
  }
};

const S = require("../helper/questionSimilarity");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "aiController.js"), "utf8");
const handler = src.slice(src.indexOf("const regenerateQuestion = asyncHandler"), src.indexOf("// ============================ Teacher chat assistant"));

console.log("measuring a rewrite against the original");
const q17Before = "$A=\\{1,2,3\\}$ və $B=\\{2,3,4\\}$ çoxluqlarının simmetrik fərqini tapın.";
const q17After = "$A=\\{1,2,3\\}$ və $B=\\{2,3,4\\}$ üçün $A\\setminus B$ fərqini tapın.";
const q15Before = "$A=\\{1,2,3\\}$ və $B=\\{a,b,c\\}$ çoxluğunun kartezian hasilində neçə nizamlı cüt vardır?";
const q15After = "Bir kafedə 3 növ sendviç və 3 növ içki var. Müştəri bir sendviç və bir içki seçir. Bütün mümkün seçimlər nizamlı cütlərlə göstərilərsə, neçə fərqli nizamlı cüt alınar?";
ok("Q17's near-copy reads as the same question", S.stemSimilarity(q17Before, q17After) >= S.SIMILAR_AT, S.stemSimilarity(q17Before, q17After).toFixed(2));
ok("Q15's word problem reads as a new one", S.stemSimilarity(q15Before, q15After) < S.SIMILAR_AT);
ok("identical text is 1", S.stemSimilarity("2 + 2 = ?", "2 + 2 = ?") === 1);
ok("LaTeX commands do not count as words", S.stemSimilarity("$\\frac{1}{2}$", "1 2") === 1);

console.log("\nreading what the teacher asked for");
ok("'Sual dəyişsin…' asks for a new question", S.asksForNewQuestion("Sual dəyişsin məsələ tipində ver"));
ok("'başqa sual yaz' does", S.asksForNewQuestion("başqa sual yaz"));
ok("'C variantını dəyiş' is a targeted edit", !S.asksForNewQuestion("C variantını dəyiş"));
ok("'düzgün cavabı dəyiş' is a targeted edit", !S.asksForNewQuestion("düzgün cavabı dəyiş"));
ok("'tək seçim et' is not a request for a new question", !S.asksForNewQuestion("tək seçim et"));

console.log("\nthe prompt");
ok("typos are read by meaning", /yazı səhvlərini MƏNACA oxu/.test(handler));
ok("...with her own example", /«fərqi sal soruş» çox güman «fərqli sual soruş»/.test(handler));
ok("'change the question' means a new question", /SUALIN ÖZÜNÜN dəyişməsini istəyirsə/.test(handler));
ok("returning the same question with shuffled options is forbidden", /variantlarını qarışdırıb qaytarmaq QADAĞANDIR/.test(handler));
ok("an ambiguous request leans to a visible change", /GÖRÜNƏCƏK dərəcədə dəyişmək istədiyini/.test(handler));
ok("the old 'don't make it a different question' bias is gone", !/onu tamam başqa suala çevirmə/.test(handler));
ok("her instruction still reaches the model", /MÜƏLLİMİN İSTƏYİ: \$\{String\(instructions\)\.trim\(\)\.slice\(0, 1000\)\}/.test(handler));

console.log("\nchecking the result");
ok("the result is measured against the original", /SIM\.stemSimilarity\(question\.text, fresh\.text\)/.test(handler));
ok("a 'change it' that came back the same is retried once", /if \(hasInstr && similarity >= SIM\.SIMILAR_AT && SIM\.asksForNewQuestion\(instructions\)\)/.test(handler));
ok("...and the retry only wins if it is a real, valid change", /if \(next && !auditQuestions\(\[next\], \{ requireAnswers: true \}\)\.length\)[\s\S]{0,140}if \(s2 < similarity\)/.test(handler));
ok("the page is told how close it is", /res\.json\(\{ question: fresh, cost, issues, verified, similarity: [^}]*similar \}\)/.test(handler));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
