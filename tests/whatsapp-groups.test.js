/*
 * The notify-group picker's list. getChats() hung in prod (2026-10-05) and the
 * picker stayed empty; the groups are now read from WhatsApp Web's own chat list,
 * with getChats only as a time-boxed fallback. This proves the list is shaped
 * right and that a call which never answers can no longer hang the request.
 */
const wa = require("../helper/whatsapp");

let passed = 0, failed = 0;
const ok = (n, c, extra) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const never = () => new Promise(() => {});

async function main() {
  // ── shaping ──
  const shaped = wa.shapeGroups([
    { id: "1@g.us", name: "9A valideynlər", size: 31, t: 100 },
    { id: "2@g.us", name: "", size: 0, t: 300 },
    { id: "3@g.us", name: "Köhnə qrup", size: 12, readOnly: true, t: 999 },
    { id: "4@g.us", name: "Məktəb icması", community: true, t: 500 },
    { id: "994501112233@c.us", name: "Bir adam", t: 800 },
    { id: "5@g.us", name: "Riyaziyyat 11", size: 18, t: 200 },
    null,
  ]);
  ok("only groups, never a person or a community parent", shaped.every((g) => g.id.endsWith("@g.us")) && !shaped.some((g) => g.id === "4@g.us"));
  ok("writable groups first, the most recently used on top", shaped.map((g) => g.id).join() === "2@g.us,5@g.us,1@g.us,3@g.us", shaped.map((g) => g.id).join());
  ok("a nameless group gets a name, an unknown size stays unknown", shaped[0].name === "Adsız qrup" && shaped[0].size === null);
  ok("members and read-only are carried", shaped[2].size === 31 && shaped[3].readOnly === true);
  ok("no internal timestamp leaks to the client", !("t" in shaped[0]));
  ok("garbage in, empty list out", wa.shapeGroups(undefined).length === 0);

  // ── the fast path ──
  let getChatsCalled = 0;
  wa._injectSessionForTests("g-fast", {
    ready: true,
    client: {
      pupPage: { evaluate: async () => [{ id: "7@g.us", name: "Sinif 7", size: 20, t: 1 }] },
      getChats: async () => { getChatsCalled += 1; return []; },
    },
  });
  const fast = await wa.listGroupsFor("g-fast");
  ok("reads the groups from the page", fast.length === 1 && fast[0].name === "Sinif 7" && fast[0].size === 20);
  ok("never touches the slow getChats when the page answers", getChatsCalled === 0);

  // ── the page read fails: fall back to getChats ──
  wa._injectSessionForTests("g-fallback", {
    ready: true,
    client: {
      pupPage: { evaluate: async () => { throw new Error("window.require is not a function"); } },
      getChats: async () => [
        { isGroup: true, id: { _serialized: "8@g.us" }, name: "Fallback qrup", participants: [1, 2, 3], timestamp: 5 },
        { isGroup: false, id: { _serialized: "1@c.us" }, name: "Şəxs" },
      ],
    },
  });
  const fb = await wa.listGroupsFor("g-fallback");
  ok("falls back to getChats when the page read breaks", fb.length === 1 && fb[0].name === "Fallback qrup" && fb[0].size === 3, JSON.stringify(fb));

  // ── both hang: the request still answers, empty, within the box ──
  wa._injectSessionForTests("g-hang", { ready: true, client: { pupPage: { evaluate: never }, getChats: never } });
  const t0 = Date.now();
  const hung = await wa.listGroupsFor("g-hang", { timeoutMs: 150 });
  ok("a call that never answers can no longer hang the picker", Array.isArray(hung) && hung.length === 0 && Date.now() - t0 < 1500, Date.now() - t0);

  // ── not linked: nothing, at once ──
  wa._injectSessionForTests("g-off", { ready: false, client: null });
  ok("an unlinked number lists nothing", (await wa.listGroupsFor("g-off")).length === 0);

  // ── the dialog can name the linked number ──
  wa._injectSessionForTests("g-me", { ready: true, client: { info: { wid: { user: "994505440307" }, pushname: "Rufi" } } });
  const st = wa.getStatusFor("g-me");
  ok("status names the linked number and its WhatsApp name", st.phone === "994505440307" && st.name === "Rufi");
  ok("an unlinked status names nothing", wa.getStatusFor("g-off").phone === "");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
