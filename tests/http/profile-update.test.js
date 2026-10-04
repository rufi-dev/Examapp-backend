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
