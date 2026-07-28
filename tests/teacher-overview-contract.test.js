process.env.CRYPTR_KEY ||= "test-key";
const { teacherOverviewExamDto } = require("../controllers/userController");
let passed = 0, failed = 0;
const ok = (name, condition) => {
  if (condition) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name); }
};
const base = {
  _id: "exam-1",
  name: "Algebra",
  title: "wrong legacy field",
  isArchived: true,
  duration: 3600,
  createdAt: new Date("2026-01-01"),
};
const active = teacherOverviewExamDto({ ...base, deletedAt: null });
const archived = teacherOverviewExamDto({ ...base, deletedAt: new Date("2026-02-01") });
ok("DTO uses name", active.name === "Algebra");
ok("active derives archived=false from deletedAt", active.archived === false);
ok("archived derives archived=true from deletedAt", archived.archived === true);
ok("nonexistent title is not serialized", !Object.hasOwn(active, "title"));
ok("nonexistent isArchived is not serialized", !Object.hasOwn(active, "isArchived"));
ok("DTO is explicitly projected", Object.keys(active).sort().join(",") === "_id,archived,class,createdAt,duration,name");
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
