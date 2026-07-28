// SMTP smoke test. Run from the backend root:
//   node utils/testEmail.js recipient@example.com
// Inside Docker:
//   docker compose exec -T backend node utils/testEmail.js recipient@example.com
// Uses the same EMAIL_* env vars the app uses and the verifyEmail template.
require("dotenv").config();
const { sendNotification } = require("./sendEmail");

(async () => {
  const to = process.argv[2] || process.env.EMAIL_USER;
  if (!to) {
    console.error("Usage: node utils/testEmail.js recipient@example.com");
    process.exit(1);
  }
  console.log(`Host=${process.env.EMAIL_HOST} Port=${process.env.EMAIL_PORT || 587} -> sending to ${to} ...`);
  try {
    // CR-108: typed, server-owned notification — no client-selected template/link.
    const info = await sendNotification({
      kind: "verify",
      to,
      subject: "Test - Examopia",
      name: "Test",
      link: "/",
    });
    console.log("OK — accepted:", info.accepted, "messageId:", info.messageId);
    process.exit(0);
  } catch (e) {
    console.error("FAILED:", e.message);
    process.exit(1);
  }
})();
