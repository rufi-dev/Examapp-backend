/*
 * Parent accounts and password resets, end to end over the real routers: a
 * parent a teacher creates can sign in with the password they were given, and
 * a student whose password a teacher resets can sign in with the new one.
 *
 * Both used to hash the password before the user model hashed it again on
 * save, so the stored value was a hash of the hash: the created parent and the
 * reset student were locked out. The old tests only read the source text.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-parent-flow";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-parent-flow";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

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

async function main() {
  console.log("parent accounts and password resets");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "parentflow" });

  const User = require("../../models/userModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");
  await User.createIndexes().catch(() => {});

  const mk = (o) => User.create({ password: "Baslangic1", isVerified: true, ...o });
  const teacher = await mk({ name: "T", email: "t@pf.test", role: "teacher", teacherApproval: "approved" });
  const other = await mk({ name: "T2", email: "t2@pf.test", role: "teacher", teacherApproval: "approved" });
  const admin = await mk({ name: "A", email: "a@pf.test", role: "admin" });
  const student = await mk({ name: "Aysel", email: "s@pf.test", role: "student" });
  const foreign = await mk({ name: "Orxan", email: "s2@pf.test", role: "student" });
  const lonely = await mk({ name: "Tənha valideyn", email: "p0@pf.test", role: "parent" });

  const db = mongoose.connection.db;
  const classA = new mongoose.Types.ObjectId();
  const classB = new mongoose.Types.ObjectId();
  await db.collection("classes").insertMany([
    { _id: classA, name: "9A", owner: teacher._id, deletedAt: null },
    { _id: classB, name: "9B", owner: other._id, deletedAt: null },
  ]);
  await db.collection("enrollments").insertMany([
    { student: student._id, class: classA, teacher: teacher._id, status: "approved" },
    { student: foreign._id, class: classB, teacher: other._id, status: "approved" },
  ]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use("/api/parent", require("../../routes/parentRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const call = async (method, path, who, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(who ? { Authorization: `Bearer ${generateToken(who._id, who.sessionVersion)}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const login = (email, password) => call("POST", "/api/users/login", null, { email, password });

  // ── a parent the teacher creates can sign in ──
  const created = await call("POST", "/api/parent/accounts", teacher, {
    name: "Vüsalə",
    email: "parent@pf.test",
    password: "Valideyn12",
    studentIds: [String(student._id)],
  });
  ok("the teacher creates a parent for their student", created.status === 201, `${created.status} ${created.body.message || ""}`);
  const parentIn = await login("parent@pf.test", "Valideyn12");
  ok("the new parent signs in with the password they were given", parentIn.status === 200, `${parentIn.status} ${parentIn.body.message || ""}`);

  // ── a reset student signs in with the new password, and only with it ──
  await User.updateOne({ _id: student._id }, { $set: { trustedDevices: [{ tokenHash: "x", createdAt: new Date(), expiresAt: new Date(Date.now() + 864e5) }] } });
  const before = await User.findById(student._id).lean();
  const reset = await call("PATCH", `/api/parent/managed/${student._id}/password`, teacher, { password: "Yeni2026a" });
  ok("the teacher resets their student's password", reset.status === 200, `${reset.status} ${reset.body.message || ""}`);
  // Read before signing in again: a fresh sign-in trusts its own device anew.
  const after = await User.findById(student._id).select("+trustedDevices").lean();
  ok("their other sessions are closed", (after.sessionVersion || 0) > (before.sessionVersion || 0), `${before.sessionVersion} -> ${after.sessionVersion}`);
  ok("and devices trusted without a password are forgotten", Array.isArray(after.trustedDevices) && after.trustedDevices.length === 0, JSON.stringify(after.trustedDevices));
  ok("the student signs in with the new password", (await login("s@pf.test", "Yeni2026a")).status === 200);
  ok("the old password stops working", (await login("s@pf.test", "Baslangic1")).status !== 200);

  // ── and nobody reaches beyond their own students ──
  const theirs = await call("PATCH", `/api/parent/managed/${foreign._id}/password`, teacher, { password: "Yeni2026a" });
  ok("a teacher cannot reset another teacher's student", theirs.status === 403, `status ${theirs.status}`);
  const staff = await call("PATCH", `/api/parent/managed/${other._id}/password`, teacher, { password: "Yeni2026a" });
  ok("nor a teacher's password", staff.status === 403, `status ${staff.status}`);
  const weak = await call("PATCH", `/api/parent/managed/${student._id}/password`, teacher, { password: "123" });
  ok("a weak password is refused", weak.status === 400, `status ${weak.status}`);
  const adminTeacher = await call("PATCH", `/api/parent/managed/${other._id}/password`, admin, { password: "Muellim2026" });
  ok("an admin can set a teacher's password", adminTeacher.status === 200 && (await login("t2@pf.test", "Muellim2026")).status === 200, `status ${adminTeacher.status}`);
  const otherAdmin = await mk({ name: "A2", email: "a2@pf.test", role: "admin" });
  const adminAdmin = await call("PATCH", `/api/parent/managed/${otherAdmin._id}/password`, admin, { password: "Admin2026y" });
  ok("but never another admin's", adminAdmin.status === 403, `status ${adminAdmin.status}`);
  const byAdmin = await call("PATCH", `/api/parent/managed/${foreign._id}/password`, admin, { password: "Admin2026x" });
  ok("an admin can reset any student", byAdmin.status === 200 && (await login("s2@pf.test", "Admin2026x")).status === 200, `status ${byAdmin.status}`);

  // ── a teacher approves a parent's pending request ──
  const asker = await mk({ name: "Gözləyən", email: "p1@pf.test", role: "parent" });
  const ParentLink = require("../../models/parentLinkModel");
  const link = await ParentLink.create({ parent: asker._id, student: student._id, status: "pending", via: "email" });
  const approve = await call("PATCH", `/api/parent/teacher/link/${link._id}`, teacher, { action: "approve" });
  ok("the teacher approves a pending parent request", approve.status === 200 && (await ParentLink.findById(link._id)).status === "approved", `status ${approve.status}`);

  // ── the admin directory says which parents follow nobody ──
  const dir = await call("GET", "/api/users/getUsers", admin);
  const rows = Array.isArray(dir.body) ? dir.body : dir.body.items || [];
  const vusale = rows.find((u) => u.email === "parent@pf.test");
  const alone = rows.find((u) => String(u._id) === String(lonely._id));
  ok("a linked parent lists their child", vusale?.children?.length === 1 && vusale.children[0].name === "Aysel", JSON.stringify(vusale?.children));
  ok("an unlinked parent says so", Array.isArray(alone?.children) && alone.children.length === 0, JSON.stringify(alone?.children));
  ok("and nobody else gets a children list", !rows.some((u) => u.role !== "parent" && "children" in u));

  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
