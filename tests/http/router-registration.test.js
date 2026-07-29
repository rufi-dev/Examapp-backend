/*
 * AUD-005 CR-047 — PRODUCTION-router wiring evidence. Loads the REAL route files
 * (routes/quizRoute, routes/userRoute, routes/achivementRoute) and asserts, by
 * referential identity against the REAL middleware, that the capability gates are
 * actually registered on the production routes — so the enforcement proven at the
 * middleware/controller level in the other suites is the enforcement that ships.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud005-router";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-aud005-router";

const { protect, teacherOnly, adminOnly, verifiedOnly } = require("../../middleware/authMiddleware");
const quizRouter = require("../../routes/quizRoute");
const userRouter = require("../../routes/userRoute");
const achRouter = require("../../routes/achivementRoute");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

// The handler chain registered for a given method+path on an Express router.
function handlers(router, method, path) {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method]) {
      return layer.route.stack.map((l) => l.handle);
    }
  }
  return null;
}
const gatedBy = (router, method, path, mw) => {
  const h = handlers(router, method, path);
  return Array.isArray(h) && h.includes(mw);
};
// Count production routes carrying a given gate — proves broad, not incidental, wiring.
function countGated(router, mw) {
  let n = 0;
  for (const layer of router.stack) {
    if (layer.route && layer.route.stack.some((l) => l.handle === mw)) n += 1;
  }
  return n;
}
// CR-124: requireCapability returns a fresh function per call, tagged with the exact
// capability. Detect the exact own-scope/AI capability wired on a shipping route.
const gatedByCapability = (router, method, path, cap) => {
  const h = handlers(router, method, path);
  return Array.isArray(h) && h.some((fn) => fn && fn._requiredCapability === cap);
};
const countCapability = (router) => {
  let n = 0;
  for (const layer of router.stack) {
    if (layer.route && layer.route.stack.some((l) => l.handle && l.handle._requiredCapability)) n += 1;
  }
  return n;
};

// ── quizRoute: CR-124 own-scope routes are requireCapability(exact cap) + protect ──
ok("quiz GET /getResultsByExam/:examId is protect + results:view:own", gatedBy(quizRouter, "get", "/getResultsByExam/:examId", protect) && gatedByCapability(quizRouter, "get", "/getResultsByExam/:examId", "results:view:own"));
ok("quiz POST /addExam/:classId is exam:create:own", gatedByCapability(quizRouter, "post", "/addExam/:classId", "exam:create:own"));
ok("quiz POST /addQuestion/:examId is exam:create:own", gatedByCapability(quizRouter, "post", "/addQuestion/:examId", "exam:create:own"));
ok("quiz PATCH /editExam/:examId is exam:manage:own", gatedByCapability(quizRouter, "patch", "/editExam/:examId", "exam:manage:own"));
ok("quiz GET /getExams is results:view:own", gatedByCapability(quizRouter, "get", "/getExams", "results:view:own"));
ok("quiz POST /chat (AI) is ai:use:own", gatedByCapability(quizRouter, "post", "/chat", "ai:use:own"));
// own-scope/AI routes are NO LONGER the broad teacherOnly gate (capability now)
ok("quiz POST /addExam/:classId is NOT teacherOnly (moved to capability)", !gatedBy(quizRouter, "post", "/addExam/:classId", teacherOnly));
// risky/global routes STAY teacherOnly (approved-only)
ok("quiz POST /addExamToUserById/:userId stays teacherOnly (global mutation)", gatedBy(quizRouter, "post", "/addExamToUserById/:userId", teacherOnly));
ok("quiz POST /class/:classId/addStudent stays teacherOnly (invite/roster)", gatedBy(quizRouter, "post", "/class/:classId/addStudent", teacherOnly));
ok("quiz GET /aiUsage is adminOnly", gatedBy(quizRouter, "get", "/aiUsage", adminOnly));
// the CR-044 student-facing controller paths ARE registered on the production router
ok("quiz POST /exam/:examId/start is a protected student route (startAttempt)", gatedBy(quizRouter, "post", "/exam/:examId/start", protect));
ok("quiz GET /reviewByResult/:resultId is protect+verifiedOnly (reviewByResult)", gatedBy(quizRouter, "get", "/reviewByResult/:resultId", protect) && gatedBy(quizRouter, "get", "/reviewByResult/:resultId", verifiedOnly));
ok("quizRoute wires the capability gate BROADLY (own-scope + AI, >= 20)", countCapability(quizRouter) >= 20);
ok("quizRoute still gates risky routes with teacherOnly (>= 8)", countGated(quizRouter, teacherOnly) >= 8);

// ── userRoute ──
ok("user GET /getUsers is teacherOnly", gatedBy(userRouter, "get", "/getUsers", teacherOnly));
ok("user PATCH /bulk is adminOnly", gatedBy(userRouter, "patch", "/bulk", adminOnly));
ok("user POST /upgradeUser is adminOnly", gatedBy(userRouter, "post", "/upgradeUser", adminOnly));

// ── achivementRoute (teacher testimonials): approved teachers/admins may add
//    their own story (teacherOnly); delete is protect-only with an owner-or-admin
//    check in the controller; read stays public ──
ok("ach POST /addAchivement is teacherOnly (approved teacher or admin)", gatedBy(achRouter, "post", "/addAchivement", teacherOnly));
ok("ach POST /addAchivement is protected", gatedBy(achRouter, "post", "/addAchivement", protect));
ok("ach DELETE /deleteAchivement/:achivementId is protect (owner-or-admin enforced in controller)", gatedBy(achRouter, "delete", "/deleteAchivement/:achivementId", protect));
ok("ach DELETE /deleteAchivement/:achivementId is NOT gated by adminOnly (teachers delete their own)", !gatedBy(achRouter, "delete", "/deleteAchivement/:achivementId", adminOnly));
ok("ach GET /getAchivements is NOT gated by teacherOnly/adminOnly (public read)", !gatedBy(achRouter, "get", "/getAchivements", teacherOnly) && !gatedBy(achRouter, "get", "/getAchivements", adminOnly));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
