/* eslint-env node */
/*
 * "Cavabları tap" makes the SERVER fetch a URL the browser supplied.
 *
 * That is the part worth being careful about. The pictures a teacher attaches
 * live on an image host, so solving a paper with diagrams means we go and get
 * them — and a crafted `image` field is then a request we make, from inside our
 * own network, with the bytes handed to a model afterwards. `http://169.254.169.254/`
 * is the classic one; so is anything on a private address, or a redirect to one.
 *
 * So the fetcher is deliberately narrow, and this file holds it to that: https
 * only, allow-listed hosts only, images only, bounded in count and in size, and
 * every failure skipped rather than fatal — a picture we cannot vouch for means
 * a question the model declines to answer, which the caller then leaves blank
 * for the teacher.
 */
process.env.NODE_ENV = "test";

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

const { safeUrl, figureUrls, collectFigures, ALLOWED_HOSTS, MAX_FIGURES } = require("../helper/questionFigures");

async function main() {
  console.log("the pictures a question carries");

  console.log("\nwhat the server will NOT go and fetch:");
  const refused = [
    ["http://res.cloudinary.com/x.png", "plain http"],
    ["https://169.254.169.254/latest/meta-data/", "the cloud metadata address"],
    ["http://169.254.169.254/", "...over http too"],
    ["https://localhost/secret.png", "localhost"],
    ["https://127.0.0.1/secret.png", "loopback"],
    ["https://10.0.0.5/internal.png", "a private address"],
    ["https://192.168.1.1/router.png", "...and another"],
    ["https://evil.example.com/x.png", "a host nobody allow-listed"],
    ["file:///etc/passwd", "a local file"],
    ["ftp://res.cloudinary.com/x.png", "a non-http scheme"],
    ["", "nothing at all"],
    [null, "null"],
    ["res.cloudinary.com/x.png", "a bare host with no scheme"],
    /*
     * The one that looks safest and is not: userinfo before an @ makes the real
     * host the part AFTER it, so a naive "does it contain our host" check passes
     * while the request goes to the attacker.
     */
    ["https://res.cloudinary.com@evil.example.com/x.png", "our host smuggled into userinfo"],
  ];
  for (const [url, why] of refused) ok(`refuses ${why}`, safeUrl(url) === null, String(safeUrl(url)));

  console.log("\nwhat it will:");
  ok("an https URL on the allow-listed host", !!safeUrl(`https://${ALLOWED_HOSTS[0]}/demo/image/upload/v1/q9.png`));
  ok("...case-insensitively on the host", !!safeUrl(`https://${ALLOWED_HOSTS[0].toUpperCase()}/a.png`));
  ok("a data URI is left alone (already inline, nothing to fetch)", safeUrl("data:image/png;base64,AAA") === null);

  console.log("\nevery picture in a paper is found, and tagged with its question:");
  const host = ALLOWED_HOSTS[0];
  const paper = [
    { type: "reading", text: "passage" },
    { type: "Cm", text: "q1", image: `https://${host}/a.png` },
    { type: "Cm", text: "q2", images: [`https://${host}/b.png`, `https://${host}/c.png`] },
    { type: "Cm", text: "q3", choices: [{ image: `https://${host}/d.png` }, { text: "plain" }] },
    { type: "Cm", text: "q4", image: "https://evil.example.com/e.png" },
    { type: "Cm", text: "q5", image: `https://${host}/a.png` }, // the same picture twice
  ];
  const found = figureUrls(paper);
  ok("four distinct pictures, not five", found.length === 4, JSON.stringify(found.map((f) => f.url)));
  ok("the untrusted host is dropped", !found.some((f) => f.url.includes("evil.example.com")));
  ok("a repeat is not fetched twice", found.filter((f) => f.url.endsWith("a.png")).length === 1);
  /*
   * The tag matters as much as the picture. A model handed twelve loose images
   * has to guess which question each belongs to, which is a fresh way to get the
   * same question wrong.
   */
  ok("each one says which question it belongs to", found.every((f) => Number.isInteger(f.forQuestion) && f.forQuestion > 0));
  ok("...counted over the WHOLE paper, passages included", found.find((f) => f.url.endsWith("a.png")).forQuestion === 2);

  console.log("\nand it is bounded:");
  const many = Array.from({ length: MAX_FIGURES + 15 }, (_, i) => ({ type: "Cm", image: `https://${host}/p${i}.png` }));
  ok(`never more than ${MAX_FIGURES} pictures`, figureUrls(many).length === MAX_FIGURES, String(figureUrls(many).length));

  console.log("\na paper with no pictures costs no fetches at all:");
  const none = await collectFigures([{ type: "Cm", text: "plain" }]);
  ok("no parts", none.parts.length === 0);
  ok("nothing reported missing", none.missing === 0);

  console.log("\nnothing is fetched from a host we do not trust:");
  /*
   * Belt and braces: even if figureUrls let something through, the collector
   * must not make the request. Any fetch at all here is a failure.
   */
  const realFetch = globalThis.fetch;
  let attempted = [];
  globalThis.fetch = async (u) => {
    attempted.push(String(u));
    throw new Error("blocked by the test");
  };
  try {
    const out = await collectFigures([
      { type: "Cm", image: "https://evil.example.com/x.png" },
      { type: "Cm", image: "https://169.254.169.254/latest/" },
      { type: "Cm", image: "http://10.0.0.1/x.png" },
    ]);
    ok("no request was made", attempted.length === 0, attempted.join(", "));
    ok("and nothing came back", out.parts.length === 0);
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
