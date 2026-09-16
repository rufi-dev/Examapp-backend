/*
 * A failure inside WhatsApp's headless browser is WhatsApp's problem, not the
 * platform's.
 *
 * On 2026-09-16 at 06:10 whatsapp-web.js rejected a promise inside its own
 * navigation handler ("Execution context was destroyed") — a promise no code of
 * ours holds, so no .catch() of ours could reach it. Node treats an unhandled
 * rejection as fatal, so the whole API went down with it: every teacher and
 * student disconnected, every in-flight request dropped, three WhatsApp sessions
 * logged out. The session's own start watchdog in helper/whatsapp.js already
 * recycles a start that hangs, so the right response here is to log it and let
 * that do its job.
 *
 * Narrow on purpose. Only a rejection whose stack runs through whatsapp-web.js
 * or puppeteer is contained; anything else is rethrown, which keeps Node's
 * fail-fast crash and lets Docker restart a clean process — an unknown failure
 * in our own code should not be quietly survived.
 */
const BROWSER_LAYER = /whatsapp-web\.js|puppeteer/;

function onUnhandledRejection(reason) {
  const trace = String((reason && (reason.stack || reason.message)) || reason);
  if (BROWSER_LAYER.test(trace)) {
    console.error(
      "[WHATSAPP] contained a browser failure, API stays up:",
      String((reason && reason.message) || reason).slice(0, 200)
    );
    return true;
  }
  throw reason;
}

module.exports = { onUnhandledRejection, BROWSER_LAYER };
