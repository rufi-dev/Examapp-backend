const crypto = require("crypto");
const jwt = require("jsonwebtoken");

// AUD-002 token helpers (docs/adr/AUD-002-session-lifecycle.md §2.1).
//
// Refresh token wire format: `<sid>.<gen>.<secret>` where `secret` is a
// high-entropy random string. Only the secret's SHA-256 hash is stored on the
// Session; sid/gen are plaintext locators. Access tokens are JWTs that DO carry
// `exp` and `sid`, unlike the legacy generateToken (which is left untouched so
// the flag-off path is byte-for-byte unchanged — Rule 5).

const newSid = () => crypto.randomBytes(18).toString("base64url"); // 144 bits
const newSecret = () => crypto.randomBytes(32).toString("base64url"); // 256 bits
const hashSecret = (secret) => crypto.createHash("sha256").update(String(secret)).digest("hex");

// Build the opaque refresh token a client receives.
const buildRefreshToken = (sid, gen, secret) => `${sid}.${gen}.${secret}`;

// Parse `<sid>.<gen>.<secret>`; returns null on any malformation (case 0).
const parseRefreshToken = (raw) => {
  if (typeof raw !== "string") return null;
  const i = raw.indexOf(".");
  const j = raw.indexOf(".", i + 1);
  if (i <= 0 || j <= i + 1 || j >= raw.length - 1) return null;
  const sid = raw.slice(0, i);
  const genStr = raw.slice(i + 1, j);
  const secret = raw.slice(j + 1);
  if (!/^\d+$/.test(genStr)) return null;
  const gen = Number(genStr);
  if (!Number.isSafeInteger(gen)) return null;
  return { sid, gen, secret };
};

// Access JWT WITH exp + sid + the captured epoch (sv). `type: "access"` so it
// cannot be confused with the rollback JWT (ADR-015).
const generateAccessToken = (userId, sv, sid, ttlMs) => {
  return jwt.sign(
    { id: String(userId), sv, sid, type: "access" },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(ttlMs / 1000) }
  );
};

// Rollback-mode session JWT: bounded exp, carries sv (so reset/logout-all still
// bite), NO sid (no Session record). `type: "rollback"` (ADR-010/ADR-015).
const generateRollbackToken = (userId, sv, ttlMs) => {
  return jwt.sign(
    { id: String(userId), sv, type: "rollback" },
    process.env.JWT_SECRET,
    { expiresIn: Math.floor(ttlMs / 1000) }
  );
};

module.exports = {
  newSid,
  newSecret,
  hashSecret,
  buildRefreshToken,
  parseRefreshToken,
  generateAccessToken,
  generateRollbackToken,
};
