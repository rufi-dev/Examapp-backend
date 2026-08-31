// Ownership rules for teacher/student-managed parent accounts. These are the
// guarantees that matter: a teacher must never reach beyond their own students, a
// student never beyond themselves, and no route here may touch a staff account.
const fs = require("node:fs");
const path = require("node:path");
const { describe, it, expect } = require("vitest");

const SRC = fs.readFileSync(path.resolve(__dirname, "../controllers/parentController.js"), "utf8");
const ROUTES = fs.readFileSync(path.resolve(__dirname, "../routes/parentRoute.js"), "utf8");

// Load the two pure gatekeepers with stubbed models, so the real logic is exercised.
function loadGuards({ ownedStudents = [], ownedClasses = [{ _id: "c1" }] } = {}) {
  const body = SRC.slice(SRC.indexOf("async function manageableStudentIds"), SRC.indexOf("// POST /api/parent/accounts"));
  const ClassModel = { find: () => ({ select: () => ({ lean: async () => ownedClasses }) }) };
  const Enrollment = {
    find: (q) => ({
      select: () => ({
        lean: async () => {
          const asked = q.student ? q.student.$in.map(String) : null;
          return ownedStudents.filter((s) => !asked || asked.includes(s)).map((s) => ({ student: s }));
        },
      }),
    }),
  };
  // eslint-disable-next-line no-new-func
  return new Function("ClassModel", "Enrollment", `${body}\nreturn { manageableStudentIds, allManagedStudentIds };`)(ClassModel, Enrollment);
}

describe("who may manage which students", () => {
  it("a student may only ever act on themselves", async () => {
    const { manageableStudentIds } = loadGuards({ ownedStudents: ["s1", "s2"] });
    const me = { _id: "s1", role: "student" };
    expect(await manageableStudentIds(me, ["s1"])).toEqual(["s1"]);
    // asking for someone else's child yields nothing, however it is requested
    expect(await manageableStudentIds(me, ["s2"])).toEqual([]);
    expect(await manageableStudentIds(me, ["s1", "s2"])).toEqual(["s1"]);
  });

  it("a teacher only gets back students enrolled in their own classes", async () => {
    const { manageableStudentIds } = loadGuards({ ownedStudents: ["s1", "s2"] });
    const teacher = { _id: "t1", role: "teacher" };
    expect(await manageableStudentIds(teacher, ["s1", "s9"])).toEqual(["s1"]);
    expect(await manageableStudentIds(teacher, ["s9"])).toEqual([]);
  });

  it("a teacher with no classes manages nobody", async () => {
    const { manageableStudentIds } = loadGuards({ ownedStudents: [], ownedClasses: [] });
    expect(await manageableStudentIds({ _id: "t1", role: "teacher" }, ["s1"])).toEqual([]);
  });

  it("an admin is not restricted", async () => {
    const { manageableStudentIds } = loadGuards({ ownedStudents: [] });
    expect(await manageableStudentIds({ _id: "a1", role: "admin" }, ["s1", "s2"])).toEqual(["s1", "s2"]);
  });

  it("a student's managed set is exactly themselves", async () => {
    const { allManagedStudentIds } = loadGuards({ ownedStudents: ["s1", "s2"] });
    expect(await allManagedStudentIds({ _id: "s7", role: "student" })).toEqual(["s7"]);
  });
});

describe("guarantees enforced in the handlers", () => {
  it("a student's target list is forced to themselves, never read from the body", () => {
    expect(SRC).toContain('const wanted = req.user.role === "student" ? [String(req.user._id)] : req.body?.studentIds;');
  });

  it("refuses when the caller manages none of the requested students", () => {
    expect(SRC).toContain("Yalnız öz şagirdiniz üçün valideyn yarada bilərsiniz");
  });

  it("never converts a non-parent account, and never resets its password", () => {
    expect(SRC).toContain('if (parent.role !== "parent") {');
    expect(SRC).toContain("Bu email başqa hesaba aiddir");
  });

  it("password reset is limited to students and parents", () => {
    expect(SRC).toContain('if (!["student", "parent"].includes(target.role)) {');
    expect(SRC).toContain("Yalnız şagird və valideyn şifrəsini dəyişmək olar");
  });

  it("password reset checks the target actually belongs to the caller", () => {
    const fn = SRC.slice(SRC.indexOf("const setManagedPassword"), SRC.indexOf("// POST /api/parent/link"));
    expect(fn).toContain("const studentIds = await allManagedStudentIds(req.user);");
    expect(fn).toContain("ParentLink.exists({ parent: target._id, student: { $in: studentIds } })");
    expect(fn).toContain("İcazə yoxdur");
  });

  it("enforces the shared password policy rather than accepting anything", () => {
    expect(SRC).toContain("const pw = validatePassword(password);");
  });

  it("notification changes are refused for a parent that is not the caller's", () => {
    const fn = SRC.slice(SRC.indexOf("const setParentNotify"), SRC.indexOf("const setManagedPassword"));
    expect(fn).toContain("ParentLink.exists({ parent: req.params.parentId, student: { $in: studentIds } })");
    expect(fn).toContain("İcazə yoxdur");
  });

  it("routes are authenticated (students need them too, so not teacherOnly)", () => {
    expect(ROUTES).toContain('router.post("/accounts", protect, createParentAccount);');
    expect(ROUTES).toContain('router.get("/managed", protect, managedParents);');
    expect(ROUTES).toContain('router.patch("/managed/:userId/password", protect, setManagedPassword);');
  });
});
