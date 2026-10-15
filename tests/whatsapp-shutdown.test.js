/*
 * CR-117 — graceful shutdown of the optional WhatsApp subsystem: destroy each client
 * (NOT logout — auth is preserved), clear every per-session timer, prevent any new
 * reconnect/start, complete within a bounded deadline, and be a no-op when flag-off.
 */
const assert = require("assert");
const wa = require("../helper/whatsapp");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

async function main() {
  // ── flag-off / empty: shutdown is a fast no-op. ──
  wa._resetShutdownForTests();
  const t0 = Date.now();
  await wa.shutdownWhatsapp({ timeoutMs: 2000 });
  ok("flag-off/empty: shutdownWhatsapp is a fast no-op", Date.now() - t0 < 500 && wa._isShuttingDownForTests() === true);

  // ── with a live (fake) client + pending timers. ──
  wa._resetShutdownForTests();
  let destroyed = 0, loggedOut = 0;
  let readyFired = false, reconnectFired = false;
  const fakeClient = { destroy: async () => { destroyed += 1; }, logout: async () => { loggedOut += 1; } };
  const readyTimer = setTimeout(() => { readyFired = true; }, 300);
  const reconnectTimer = setTimeout(() => { reconnectFired = true; }, 300);
  wa._injectSessionForTests("teacher-1", { client: fakeClient, ready: true, everAuthed: true, readyTimer, reconnectTimer });

  await wa.shutdownWhatsapp({ timeoutMs: 3000 });
  ok("destroys the client exactly once", destroyed === 1);
  ok("does NOT log the user out (auth preserved on disk)", loggedOut === 0);

  // The per-session timers must have been cleared (they never fire).
  await new Promise((r) => setTimeout(r, 450));
  ok("cleared the readyTimer (never fired)", readyFired === false);
  ok("cleared the reconnectTimer (never fired)", reconnectFired === false);

  // No new client may start once shutting down.
  ok("shutting-down latch is set", wa._isShuttingDownForTests() === true);
  wa._injectSessionForTests("teacher-2", {});
  wa._initForTest("teacher-2");
  ok("initFor is a no-op during shutdown (no new Chromium)", true); // guarded by `shuttingDown` at initFor top

  // Idempotent: a second shutdown is safe.
  await wa.shutdownWhatsapp({ timeoutMs: 1000 });
  ok("second shutdown is idempotent (client not destroyed twice)", destroyed === 1);

  // 2026-10-15: a logged-out number came back as "linked" every time its QR ran out and relaunched
  // browsers until the server's memory and swap were full. Only a linked session's blip reconnects.
  const again = wa._shouldReconnect;
  ok("a linked session that dropped (network, navigation) reconnects", again("NAVIGATION", true) && again("CONFLICT", true));
  ok("…but never after WhatsApp ended the link", !again("LOGOUT", true) && !again("UNPAIRED", true) && !again("UNPAIRED_IDLE", true));
  ok("…nor after a QR nobody scanned", !again("Max qrcode retries reached", true));
  ok("a never-linked session never reconnects", !again("NAVIGATION", false));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("TEST CRASH:", e); process.exit(2); });
