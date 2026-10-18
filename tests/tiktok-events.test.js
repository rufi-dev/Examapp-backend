/* eslint-env node */
/*
 * The TikTok Events API (owner, 2026-10-18: "Implement Events API… set this
 * up"): what the server sends TikTok for a sign-up, a class and an exam, how a
 * person is matched without anything readable leaving the server, and that a
 * test run never calls TikTok.
 */
process.env.NODE_ENV = "test";
process.env.CRYPTR_KEY = process.env.CRYPTR_KEY || "test-cryptr-tiktok";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-tiktok";
process.env.TIKTOK_PIXEL_ID = "PIXEL123";
process.env.TIKTOK_EVENTS_TOKEN = "token-abc";
process.env.FRONTEND_URL = "https://examopia.com";

const crypto = require("crypto");
const { buildPayload, e164, post, tiktokEvent, enabled, ENDPOINT } = require("../services/tiktokEvents");
const { cleanAcquisition } = require("../controllers/userController");

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
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

(async () => {
  const user = { _id: "64b000000000000000000001", email: "  Aysel@Mail.AZ ", phone: "+994501112233", acquisition: { ttclid: "E.C.P.abc123" } };
  const req = { ip: "::ffff:85.132.1.2", get: (h) => (h === "user-agent" ? "Mozilla/5.0 (iPhone)" : undefined), cookies: { _ttp: "ttp-cookie-1" } };

  console.log("\nthe sign-up, as TikTok receives it:");
  const p = buildPayload("CompleteRegistration", { eventId: "reg-64b000000000000000000001", user, req, path: "/register", properties: { content_name: "teacher" }, now: 1760000000000 });
  const d = p.data[0];
  ok("a web event for this pixel", p.event_source === "web" && p.event_source_id === "PIXEL123");
  ok("the standard event name, its time in seconds", d.event === "CompleteRegistration" && d.event_time === 1760000000);
  ok("the id the browser pixel sends (one count for both)", d.event_id === "reg-64b000000000000000000001");
  ok("email: trimmed, lower-case, SHA-256 — never readable", d.user.email === sha("aysel@mail.az") && !JSON.stringify(p).includes("aysel"));
  ok("phone: E.164, SHA-256", d.user.phone === sha("+994501112233") && !JSON.stringify(p).includes("501112233"));
  ok("the account id: SHA-256", d.user.external_id === sha("64b000000000000000000001"));
  ok("the ad click and the pixel's cookie, as they are", d.user.ttclid === "E.C.P.abc123" && d.user.ttp === "ttp-cookie-1");
  ok("the visitor's IP (no ::ffff:) and browser", d.user.ip === "85.132.1.2" && d.user.user_agent === "Mozilla/5.0 (iPhone)");
  ok("the page it happened on", d.page.url === "https://examopia.com/register");
  ok("what it was", d.properties.content_name === "teacher");
  ok("not a test event unless asked", p.test_event_code === undefined);

  process.env.TIKTOK_TEST_EVENT_CODE = "TEST42";
  ok("TIKTOK_TEST_EVENT_CODE sends it to Test events", buildPayload("CompleteRegistration", { user }).test_event_code === "TEST42");
  delete process.env.TIKTOK_TEST_EVENT_CODE;

  const bare = buildPayload("TeacherActivated", { user: { _id: "x" } }).data[0];
  ok("what is missing is left out (no empty fields)", !("email" in bare.user) && !("phone" in bare.user) && !("ttp" in bare.user) && !("event_id" in bare));

  console.log("\nphone numbers, however they were stored:");
  ok("+994 50 111 22 33", e164("+994 50 111 22 33") === "+994501112233");
  ok("994501112233", e164("994501112233") === "+994501112233");
  ok("0501112233", e164("0501112233") === "+994501112233");
  ok("501112233", e164("501112233") === "+994501112233");
  ok("none", e164("") === "");

  console.log("\nthe request:");
  let seen = null;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return { status: 200, json: async () => ({ code: 0, message: "OK" }) };
  };
  const r = await post(p, fakeFetch);
  ok("POST to /open_api/v1.3/event/track/", seen.url === ENDPOINT && seen.url.endsWith("/open_api/v1.3/event/track/") && seen.init.method === "POST");
  ok("the token in the Access-Token header, JSON body", seen.init.headers["Access-Token"] === "token-abc" && JSON.parse(seen.init.body).data[0].event === "CompleteRegistration");
  ok("TikTok's answer read back", r.code === 0);

  console.log("\na test run never calls TikTok:");
  let called = false;
  const res = await tiktokEvent("CompleteRegistration", { user }, async () => {
    called = true;
    return { status: 200, json: async () => ({}) };
  });
  ok("off under NODE_ENV=test", !enabled() && res === null && !called);

  console.log("\nthe sign-up keeps the ad click it came from:");
  ok("a ttclid alone is worth keeping", cleanAcquisition({ source: "(direct)", ttclid: "E.C.P.abc" })?.ttclid === "E.C.P.abc");
  ok("…and nothing at all is still nothing", cleanAcquisition({ source: "(direct)" }) === undefined);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
