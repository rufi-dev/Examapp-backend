/*
 * The API must survive a WhatsApp browser failure, and must NOT survive anything else.
 *
 * 2026-09-16 06:10: an unhandled rejection from inside whatsapp-web.js killed the
 * backend. The guard contains exactly that class of failure and rethrows the
 * rest, so an unknown fault in our own code still crashes and restarts clean.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { onUnhandledRejection } = require("../helper/processGuards");

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed += 1; console.log("  ✓", name); } else { failed += 1; console.log("  ✗ FAIL:", name); }
};

console.log("\nA browser-layer failure is contained:");
{
  // The exact shape of the production crash.
  const e = new Error("Execution context was destroyed, most likely because of a navigation.");
  e.stack = `${e.message}
    at rewriteError (/app/node_modules/puppeteer-core/lib/cjs/puppeteer/cdp/ExecutionContext.js:457:15)
    at async Client.inject (/app/node_modules/whatsapp-web.js/src/Client.js:146:36)`;
  const quiet = console.error;
  console.error = () => {};
  let threw = false;
  let result;
  try { result = onUnhandledRejection(e); } catch { threw = true; } finally { console.error = quiet; }
  ok("the production crash is contained, not rethrown", !threw && result === true);
}

console.log("\nAnything else still crashes:");
{
  const ours = new Error("boom in our own code");
  ours.stack = `${ours.message}\n    at saveBoard (/app/controllers/boardController.js:10:5)`;
  let threw = null;
  try { onUnhandledRejection(ours); } catch (e) { threw = e; }
  ok("a rejection from our own code is rethrown", threw === ours);
  let threwPlain = null;
  try { onUnhandledRejection("a bare string"); } catch (e) { threwPlain = e; }
  ok("so is a rejection with no stack at all", threwPlain === "a bare string");
}

console.log("\nFor real, in a separate process:");
{
  const guard = JSON.stringify(path.join(__dirname, "../helper/processGuards"));
  const run = (body) =>
    spawnSync(process.execPath, ["-e", `process.on("unhandledRejection", require(${guard}).onUnhandledRejection);${body}`], {
      encoding: "utf8",
      timeout: 15000,
    });
  const contained = run(`
    const e = new Error("Execution context was destroyed");
    e.stack = "Error\\n    at async Client.inject (/app/node_modules/whatsapp-web.js/src/Client.js:146:36)";
    Promise.reject(e);
    setTimeout(() => { console.log("still alive"); process.exit(0); }, 200);
  `);
  ok("a process with the guard outlives a WhatsApp rejection", contained.status === 0 && /still alive/.test(contained.stdout));
  const crashed = run(`
    Promise.reject(new Error("our bug"));
    setTimeout(() => { console.log("still alive"); process.exit(0); }, 200);
  `);
  ok("and still dies on its own bugs", crashed.status !== 0 && !/still alive/.test(crashed.stdout));
}

console.log("\nIt is wired:");
{
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  ok("server.js installs the guard", /process\.on\("unhandledRejection", require\("\.\/helper\/processGuards"\)\.onUnhandledRejection\)/.test(server));
}

console.log(`\n${passed} passed, ${failed} failed`);
assert.strictEqual(failed, 0, `${failed} process-guard assertions failed`);
