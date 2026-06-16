// SMTP smoke test. Run from the backend root:
//   node utils/testEmail.js recipient@example.com
// Inside Docker:
//   docker compose exec -T backend node utils/testEmail.js recipient@example.com
// Uses the same EMAIL_* env vars the app uses and the verifyEmail template.
require("dotenv").config();
const { sendEmail } = require("./sendEmail");

(async () => {
  const to = process.argv[2] || process.env.EMAIL_USER;
  if (!to) {
    console.error("Usage: node utils/testEmail.js recipient@example.com");
    process.exit(1);
  }
  console.log(
    `Host=${process.env.EMAIL_HOST} Port=${process.env.EMAIL_PORT || 587} ` +
      `User=${process.env.EMAIL_USER} -> sending to ${to} ...`
  );
  try {
    const info = await sendEmail(
      "Test - Sınaq Riyaziyyat",
      to,
      process.env.EMAIL_USER,
      "noreply@rufi.com",
      "verifyEmail",
      "Test",
      `${process.env.FRONTEND_URL || ""}/`
    );
    console.log("OK — accepted:", info.accepted, "messageId:", info.messageId);
    process.exit(0);
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exit(1);
  }
})();
