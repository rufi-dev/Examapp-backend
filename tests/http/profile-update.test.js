/*
 * Saving the profile form: an emptied bio and a removed photo actually save.
 * They used to fall back to the old value, so "Şəkli sil" and clearing the bio
 * did nothing once the page reloaded.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-profile-update";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-profile-update";

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
  console.log("profile update");
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri(), { dbName: "profileupdate" });

  const User = require("../../models/userModel");
  const { generateToken } = require("../../utils");
  const errorHandler = require("../../middleware/errorMiddleware");
  const PLACEHOLDER = User.schema.path("photo").defaultValue;

  const user = await User.create({
    name: "Aysel",
    email: "a@profile-update.test",
    password: "xxxxxxxxxxxx",
    role: "student",
    isVerified: true,
    phone: "+994501112233",
    bio: "Riyaziyyatı sevirəm",
    photo: "https://res.cloudinary.com/demo/image/upload/a.jpg",
    grade: "9",
  });

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/users", require("../../routes/userRoute"));
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const token = generateToken(user._id, user.sessionVersion);
  const patch = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/users/updateUser`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  const a = await patch({ assistantEnabled: true });
  const afterPref = await User.findById(user._id).lean();
  ok("a save without the profile fields leaves them alone", a.status === 200 && afterPref.bio === "Riyaziyyatı sevirəm" && afterPref.photo.includes("cloudinary") && afterPref.phone === "+994501112233", JSON.stringify(afterPref));
  // Retired 2026-10-13: a cached old page may still send `true`; it stays off.
  ok("the retired AI assistant cannot be switched back on", afterPref.assistantEnabled !== true, String(afterPref.assistantEnabled));

  const b = await patch({ name: "Aysel Məmmədova", phone: "+994501112233", bio: "", photo: "", grade: "9" });
  const cleared = await User.findById(user._id).lean();
  ok("the save answers", b.status === 200, `status ${b.status}`);
  ok("an emptied bio is saved empty", cleared.bio === "", JSON.stringify(cleared.bio));
  ok("a removed photo goes back to the placeholder", cleared.photo === PLACEHOLDER, cleared.photo);
  ok("the reply says so too", b.body.bio === "" && b.body.photo === PLACEHOLDER);
  ok("the name still changes", cleared.name === "Aysel Məmmədova");

  const c = await patch({ bio: "  Yeni bio  ", photo: "https://res.cloudinary.com/demo/image/upload/b.jpg" });
  const set = await User.findById(user._id).lean();
  ok("a new bio and photo save, trimmed", c.status === 200 && set.bio === "Yeni bio" && set.photo.endsWith("/b.jpg"), JSON.stringify({ bio: set.bio, photo: set.photo }));

  // ── a Google sign-up picks "teacher" on the next screen: the welcome credits come then, once ──
  const google = await User.create({ name: "Google Müəllim", email: "g@profile-update.test", password: "xxxxxxxxxxxx", isVerified: true });
  const gTok = generateToken(google._id, google.sessionVersion);
  const as = (tok) => async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/users/updateUser`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const gPatch = as(gTok);
  ok("a Google sign-up starts with no credits", ((await User.findById(google._id).lean()).aiCredits || 0) === 0);
  const chose = await gPatch({ role: "teacher", phone: "+994501112244" });
  const afterChoice = await User.findById(google._id).lean();
  ok("choosing teacher grants the welcome credits", chose.status === 200 && afterChoice.role === "teacher" && afterChoice.aiCredits === 60, JSON.stringify({ s: chose.status, role: afterChoice.role, c: afterChoice.aiCredits }));
  ok("and the reply carries them for the header", chose.body.aiCredits === 60);
  await gPatch({ role: "teacher", name: "Google Müəllim 2" });
  ok("saving again never grants them twice", (await User.findById(google._id).lean()).aiCredits === 60);
  const gStudent = await User.create({ name: "Google Şagird", email: "gs@profile-update.test", password: "xxxxxxxxxxxx", isVerified: true });
  await as(generateToken(gStudent._id, gStudent.sessionVersion))({ role: "student", phone: "+994501112255", grade: "9" });
  ok("a student who signs up the same way gets none", ((await User.findById(gStudent._id).lean()).aiCredits || 0) === 0);

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
