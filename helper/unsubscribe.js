const crypto = require("crypto");

/*
 * The "buradan imtina edin" link in an outreach email.
 *
 * It names the teacher and carries a signature of that name, so the link works
 * without logging in and cannot be edited into someone else's: a guessed or
 * altered id fails the check. Signed with the server's JWT secret, scoped by a
 * prefix so the value can never be confused with any other token we make.
 */
const secret = () => process.env.JWT_SECRET || "dev";

function unsubscribeToken(userId) {
  return crypto.createHmac("sha256", secret()).update(`unsubscribe:${String(userId)}`).digest("hex").slice(0, 32);
}

function checkUnsubscribeToken(userId, token) {
  const want = Buffer.from(unsubscribeToken(userId));
  const got = Buffer.from(String(token || ""));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* The page on the site that the link opens (the mailer only allows same-site links). */
const unsubscribePath = (userId) => `/unsubscribe?u=${encodeURIComponent(String(userId))}&t=${unsubscribeToken(userId)}`;

module.exports = { unsubscribeToken, checkUnsubscribeToken, unsubscribePath };
