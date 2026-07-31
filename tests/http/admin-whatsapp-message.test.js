/*
 * Admin user-directory WhatsApp contract.
 *
 * Proves that the selected recipient is resolved from the server-side user row,
 * the message is sent from the authenticated admin's linked session, and no
 * unauthenticated/teacher/client-selected-recipient path can use the endpoint.
 */
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-admin-whatsapp";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-admin-whatsapp";
process.env.WHATSAPP_WEB_ENABLED = "true";

const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const whatsapp = require("../../helper/whatsapp");
const whatsappRoute = require("../../routes/whatsappRoute");
const errorHandler = require("../../middleware/errorMiddleware");
const { generateToken } = require("../../utils");

let passed = 0;
let failed = 0;
const ok = (name, condition) => {
  if (condition) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", name);
  }
};

function request(server, { token, userId, body }) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.address().port,
        method: "POST",
        path: `/api/whatsapp/admin/users/${userId}/message`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            body: (() => {
              try { return JSON.parse(raw); } catch { return {}; }
            })(),
          });
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());

  const admin = await User.create({
    name: "Admin",
    email: "admin-wa@example.com",
    password: "StrongPass1",
    phone: "+994501111111",
    role: "admin",
  });
  const teacher = await User.create({
    name: "Teacher",
    email: "teacher-wa@example.com",
    password: "StrongPass1",
    phone: "+994502222222",
    role: "teacher",
    teacherApproval: "approved",
  });
  const target = await User.create({
    name: "Pəri müəllim",
    email: "target-wa@example.com",
    password: "StrongPass1",
    phone: "+994503333333",
    role: "teacher",
    teacherApproval: "approved",
  });
  const noPhone = await User.create({
    name: "No phone",
    email: "no-phone-wa@example.com",
    password: "StrongPass1",
    phone: "+994",
    role: "student",
  });

  const tokenFor = (user) => generateToken(user._id, user.sessionVersion);
  const app = express();
  app.use(express.json({ limit: "16kb" }));
  app.use("/api/whatsapp", whatsappRoute);
  app.use(errorHandler);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const message = "Salam, Pəri müəllim 😊\n\nExamopia platformasından istifadə etdiyiniz üçün sizə təşəkkür edirik ✨";

  const anonymous = await request(server, { userId: target._id, body: { message } });
  ok("anonymous caller is rejected", anonymous.status === 401);

  const nonAdmin = await request(server, {
    token: tokenFor(teacher),
    userId: target._id,
    body: { message },
  });
  ok("approved teacher cannot use the admin messaging endpoint", nonAdmin.status === 401);

  whatsapp._resetShutdownForTests();
  const disconnected = await request(server, {
    token: tokenFor(admin),
    userId: target._id,
    body: { message },
  });
  ok(
    "a disconnected admin receives the stable not-connected response",
    disconnected.status === 409 && disconnected.body.code === "whatsapp_not_connected"
  );

  const sent = [];
  whatsapp._injectSessionForTests(admin._id, {
    ready: true,
    client: {
      getNumberId: async (digits) => ({ _serialized: `${digits}@c.us` }),
      sendMessage: async (chatId, text) => sent.push({ chatId, text }),
    },
  });

  const missingMessage = await request(server, {
    token: tokenFor(admin),
    userId: target._id,
    body: { message: "" },
  });
  ok("empty messages are rejected before sending", missingMessage.status === 400 && sent.length === 0);

  const tooLong = await request(server, {
    token: tokenFor(admin),
    userId: target._id,
    body: { message: "x".repeat(3001) },
  });
  ok("oversized messages are rejected before sending", tooLong.status === 400 && sent.length === 0);

  const absent = await request(server, {
    token: tokenFor(admin),
    userId: new mongoose.Types.ObjectId(),
    body: { message },
  });
  ok("a missing user returns 404", absent.status === 404 && sent.length === 0);

  const phoneMissing = await request(server, {
    token: tokenFor(admin),
    userId: noPhone._id,
    body: { message },
  });
  ok(
    "a user without a sendable phone returns a specific validation error",
    phoneMissing.status === 422 && phoneMissing.body.code === "whatsapp_phone_missing" && sent.length === 0
  );

  const delivered = await request(server, {
    token: tokenFor(admin),
    userId: target._id,
    body: { message },
  });
  ok("valid admin send succeeds", delivered.status === 200 && delivered.body.ok === true);
  ok("the target phone comes from the selected user's server-side row", sent[0]?.chatId === "994503333333@c.us");
  ok("the exact reviewed message is delivered", sent[0]?.text === message);

  whatsapp._resetShutdownForTests();
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mem.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("TEST CRASH:", error);
  process.exit(2);
});
