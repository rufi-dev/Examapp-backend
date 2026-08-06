// Web Push (VAPID) configuration. Keys live in the server .env:
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https URL).
// When the keys are absent the module stays inert (isConfigured() === false) so
// the endpoints degrade gracefully instead of crashing the boot.
const webpush = require("web-push");

const PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:info@examopia.com";

let configured = false;
if (PUBLIC && PRIVATE) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
    configured = true;
  } catch (e) {
    console.warn("[PUSH] VAPID config failed:", e && e.message);
  }
}

const isConfigured = () => configured;
const publicKey = () => PUBLIC;

// Send a JSON payload to one subscription. Resolves on success; rejects with the
// provider error (statusCode 404/410 ⇒ the subscription is dead and should be
// pruned by the caller).
function sendTo(subscription, payload) {
  return webpush.sendNotification(subscription, JSON.stringify(payload || {}));
}

module.exports = { webpush, isConfigured, publicKey, sendTo };
