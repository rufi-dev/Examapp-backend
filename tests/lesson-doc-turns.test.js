/* eslint-env node */
/*
 * One AI turn per material at a time, and a reopened page can tell one is running.
 *
 * 9 Oct 2026: a teacher left the Studio while her first request was being written,
 * came back to a page that looked idle, asked again, and the second turn ran for a
 * minute and a half against the version from before the first one saved, then
 * failed as "Material başqa yerdə dəyişdirilib" — which she could not act on.
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

const T = require("../helper/lessonDocTurns");
const src = fs.readFileSync(path.join(__dirname, "..", "controllers", "lessonDocController.js"), "utf8");

console.log("the turn register");
ok("nothing running at first", T.runningTurn("d1") === null);
const a = T.startTurn("d1", "Rasional ədədlər 7 sinif");
const r = T.runningTurn("d1");
ok("a started turn is reported", !!r && r.text === "Rasional ədədlər 7 sinif" && !!r.since);
ok("other materials are unaffected", T.runningTurn("d2") === null);
T.endTurn("d1", {});
ok("someone else's token cannot end it", T.runningTurn("d1") !== null);
T.endTurn("d1", a);
ok("its own token ends it", T.runningTurn("d1") === null);
const b = T.startTurn("d3", "x".repeat(500));
ok("the request text is kept short", T.runningTurn("d3").text.length === 200);
T.endTurn("d3", b);

console.log("\nthe controller");
const wrapper = src.slice(src.indexOf("const streamMessage = asyncHandler"), src.indexOf("async function streamMessageTurn"));
ok("a second turn is refused while one runs", /if \(T\.runningTurn\(req\.params\.id\)\) \{\s*throw httpError\(409, "turn_running"/.test(wrapper));
ok("...after the ownership check", wrapper.indexOf("await mine(req") < wrapper.indexOf("T.runningTurn"));
ok("...and the check and the claim are in the same tick", /throw httpError\(409, "turn_running"[^;]*\);\s*\}\s*const token = T\.startTurn/.test(wrapper));
ok("the claim is always released", /try \{\s*await streamMessageTurn\(req, res\);\s*\} finally \{\s*T\.endTurn\(req\.params\.id, token\);/.test(wrapper));
ok("nothing is stored or charged before the check", !/appendMessages|meterFor/.test(wrapper));
ok("the material says whether a turn is running", /const running = require\("\.\.\/helper\/lessonDocTurns"\)\.runningTurn\(doc\._id\);/.test(src));
ok("...for teachers and admins alike", (src.match(/res\.json\(\{ doc, background: bgUri, running/g) || []).length === 2);
ok("a turn conflict says what happened", /if \(e\?\.code === "doc_conflict"\) return \{ code: "doc_conflict", message: TURN_CONFLICT \};/.test(src));
ok("...and no longer blames someone else", !/TURN_CONFLICT = "[^"]*başqa yerdə/.test(src));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
