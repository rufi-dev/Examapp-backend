/*
 * AUD-002 HTTP-stack contract regression. A minimal Express app mounting the
 * REAL flag-gated routes (requireSessionFlag → protect → handlers) + the real
 * error middleware, exercised over real sockets. Proves status codes, Set-Cookie
 * issuance/clearing, extractor behavior, middleware order, and emergency mode —
 * the layer the service/model suites don't cover.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-aud002-http";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-http";

const http = require("http");
const express = require("express");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const User = require("../../models/userModel");
const errorHandler = require("../../middleware/errorMiddleware");
const { protect } = require("../../middleware/authMiddleware");
const { _setForTest } = require("../../config/featureFlags");
const authCtl = require("../../controllers/authSessionController");
const { generateRollbackToken } = require("../../utils/refreshToken");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

function buildServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  // test-only login that issues via the real helper
  app.post("/api/users/login", async (req, res) => {
    const user = await User.findById(req.body.id);
    const token = await authCtl.issueSessionForUser(req, res, user);
    res.status(200).json({ token });
  });
  app.post("/api/users/refresh", authCtl.requireSessionFlag, authCtl.refreshHandler);
  app.post("/api/users/logoutAll", authCtl.requireSessionFlag, protect, authCtl.logoutAllHandler);
  app.get("/api/users/me", protect, (req, res) => res.json({ id: String(req.user._id) }));
  app.use(errorHandler);
  return http.createServer(app);
}

function request(server, { method = "GET", path, token, cookie, body, origin }) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : "";
    const { port } = server.address();
    const req = http.request(
      { host: "127.0.0.1", port, method, path,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(origin ? { Origin: origin } : {}),
        } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          setCookie: res.headers["set-cookie"] || [],
          body: (() => { try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; } })(),
        }));
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
const cookieVal = (setCookie, name) => {
  // A login clears then sets the same cookie, so there can be an empty (clear)
  // header AND the real one — take the LAST non-empty value.
  const matches = setCookie.filter((s) => s.startsWith(name + "="));
  for (let i = matches.length - 1; i >= 0; i--) {
    const v = matches[i].split(";")[0].slice(name.length + 1);
    if (v) return v;
  }
  return null;
};

async function main() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri());
  const server = buildServer();
  await new Promise((r) => server.listen(0, r));
  const u = await User.create({ name: "H", email: "h@e.com", password: "origPass12", role: "student" });

  // Flag OFF — routes are invisible (404), and logoutAll 404s BEFORE protect
  {
    _setForTest({ flags: { SESSION_MODEL_ENABLED: false } });
    const r1 = await request(server, { method: "POST", path: "/api/users/refresh" });
    ok("flag-off: /refresh ⇒ 404", r1.status === 404);
    const r2 = await request(server, { method: "POST", path: "/api/users/logoutAll" }); // no auth
    ok("flag-off: unauth /logoutAll ⇒ 404 (flag before protect), not 401", r2.status === 404);
  }

  // Flag ON — full login → refresh → grace → logout flow
  {
    _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: true, HONOR_EXISTING_REFRESH: true, EMERGENCY_REAUTH: false } });
    const login = await request(server, { method: "POST", path: "/api/users/login", body: { id: String(u._id) } });
    ok("login: 200 + access token in body", login.status === 200 && !!login.body.token);
    const rt0 = cookieVal(login.setCookie, "__Secure-exq_rt");
    ok("login: sets HttpOnly __Secure-exq_rt refresh cookie", !!rt0 && login.setCookie.some((s) => /__Secure-exq_rt=/.test(s) && /HttpOnly/i.test(s)));

    const ref1 = await request(server, { method: "POST", path: "/api/users/refresh", cookie: `__Secure-exq_rt=${rt0}` });
    const rt1 = cookieVal(ref1.setCookie, "__Secure-exq_rt");
    ok("refresh: 200 + new access token", ref1.status === 200 && !!ref1.body.token);
    ok("refresh: rotates the refresh cookie", !!rt1 && rt1 !== rt0);

    const grace = await request(server, { method: "POST", path: "/api/users/refresh", cookie: `__Secure-exq_rt=${rt0}` });
    const replayedRt = cookieVal(grace.setCookie, "__Secure-exq_rt");
    ok("refresh: previous cookie within grace replays the exact rotation response",
      grace.status === 200 && grace.body.token === ref1.body.token && replayedRt === rt1);

    const noc = await request(server, { method: "POST", path: "/api/users/refresh" });
    ok("refresh: no cookie ⇒ 401 reauthenticate", noc.status === 401 && noc.body.error === "reauthenticate");
    ok("refresh: 401 clears credential cookies", noc.setCookie.some((s) => /__Secure-exq_rt=/.test(s)));

    const me = await request(server, { method: "GET", path: "/api/users/me", token: ref1.body.token });
    ok("protected route: valid access token ⇒ 200", me.status === 200 && me.body.id === String(u._id));

    const la = await request(server, { method: "POST", path: "/api/users/logoutAll", token: ref1.body.token });
    ok("logoutAll: authenticated ⇒ 204", la.status === 204);
  }

  // Emergency mode — a rollback token is rejected on a protected route
  {
    _setForTest({ flags: { SESSION_MODEL_ENABLED: true, EMERGENCY_REAUTH: false } });
    const cur = await User.findById(u._id); // logoutAll above bumped sessionVersion
    const rb = generateRollbackToken(u._id, cur.sessionVersion || 0, 7 * 24 * 3600 * 1000);
    const okRes = await request(server, { method: "GET", path: "/api/users/me", token: rb });
    ok("rollback token authenticates a protected route when NOT emergency", okRes.status === 200);
    _setForTest({ flags: { EMERGENCY_REAUTH: true } });
    const em = await request(server, { method: "GET", path: "/api/users/me", token: rb });
    ok("EMERGENCY_REAUTH: rollback token ⇒ 401 on protected route", em.status === 401);
    _setForTest({ flags: { SESSION_MODEL_ENABLED: false, EMERGENCY_REAUTH: false } });
  }

  // PRODUCTION ROUTER — mount the REAL routes/userRoute and drive the REAL
  // loginUser controller end-to-end (closes the reconstructed-route gap).
  {
    const prodApp = express();
    prodApp.use(express.json());
    prodApp.use(cookieParser());
    prodApp.use("/api/users", require("../../routes/userRoute"));
    prodApp.use(errorHandler);
    const prod = http.createServer(prodApp);
    await new Promise((r) => prod.listen(0, r));

    // A real user with a hashed password (pre-save hook).
    await User.create({ name: "P", email: "prod@e.com", password: "prodPass12", role: "student", isVerified: true });

    // Flag OFF — real /refresh route is invisible; real login issues the legacy cookie.
    _setForTest({ flags: { SESSION_MODEL_ENABLED: false } });
    const off = await request(prod, { method: "POST", path: "/api/users/refresh" });
    ok("prod-router flag-off: real /refresh ⇒ 404", off.status === 404);
    const legacyLogin = await request(prod, { method: "POST", path: "/api/users/login", body: { email: "prod@e.com", password: "prodPass12" } });
    ok("prod-router flag-off: real loginUser ⇒ 200 + legacy token", legacyLogin.status === 200 && !!legacyLogin.body.token);
    ok("prod-router flag-off: legacy 'token' cookie set, NO __Secure-exq_rt", cookieVal(legacyLogin.setCookie, "token") && !cookieVal(legacyLogin.setCookie, "__Secure-exq_rt"));

    // Flag ON — real loginUser issues the new-model session cookie + access token.
    _setForTest({ flags: { SESSION_MODEL_ENABLED: true, ISSUE_NEW_MODEL: true, HONOR_EXISTING_REFRESH: true, EMERGENCY_REAUTH: false } });
    const newLogin = await request(prod, { method: "POST", path: "/api/users/login", body: { email: "prod@e.com", password: "prodPass12" } });
    const rt = cookieVal(newLogin.setCookie, "__Secure-exq_rt");
    ok("prod-router flag-on: real loginUser ⇒ 200 + access token", newLogin.status === 200 && !!newLogin.body.token);
    ok("prod-router flag-on: real loginUser sets the __Secure-exq_rt refresh cookie", !!rt);
    // CSRF (Gate 2): cookie-auth /refresh requires an allowed Origin.
    const ref = await request(prod, { method: "POST", path: "/api/users/refresh", cookie: `__Secure-exq_rt=${rt}`, origin: "https://examopia.com" });
    ok("prod-router flag-on: /refresh with allowed Origin rotates", ref.status === 200 && !!ref.body.token);
    const csrfBad = await request(prod, { method: "POST", path: "/api/users/refresh", cookie: `__Secure-exq_rt=${rt}`, origin: "https://evil.example" });
    ok("prod-router CSRF: /refresh with a disallowed Origin ⇒ 403", csrfBad.status === 403);
    const csrfMissing = await request(prod, { method: "POST", path: "/api/users/refresh", cookie: `__Secure-exq_rt=${rt}` });
    ok("prod-router CSRF: /refresh with NO Origin (cookie-auth) ⇒ 403", csrfMissing.status === 403);
    ok("prod-router flag-on: real login wrong password ⇒ 400", (await request(prod, { method: "POST", path: "/api/users/login", body: { email: "prod@e.com", password: "wrong" } })).status === 400);
    _setForTest({ flags: { SESSION_MODEL_ENABLED: false } });
    prod.close();
  }

  server.close();
  await mongoose.disconnect();
  await mem.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
