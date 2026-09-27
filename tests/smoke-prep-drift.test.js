/*
 * The smoke preparation must build EVERY index the server refuses to boot without.
 *
 * It had drifted behind twice. The boot invariant grew to demand the Teacher
 * Success indexes and then the curriculum ones; prepareSmokeDb was never taught
 * to build either, so the server refused to boot against the smoke database and
 * container-smoke failed. Because the suite was one `&&` chain, it stopped
 * there - and the fifty files after it had not run in who knows how long.
 *
 * The drift is silent by nature: adding a migration to the boot check is one
 * file, teaching the preparation to run it is another, and nothing connected
 * them. This connects them. Every migration the server names in a "run this
 * migration" refusal has to appear in the preparation, or this fails and says
 * which one is missing.
 */
const fs = require("fs");
const path = require("path");

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

const BE = path.join(__dirname, "..");

/* Every source file that can refuse a boot, minus the migrations themselves. */
const sources = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (["node_modules", ".git", "migrations", "tests", "uploads"].includes(e.name)) continue;
      walk(full);
    } else if (e.name.endsWith(".js") || e.name.endsWith(".cjs")) {
      sources.push(full);
    }
  }
};
walk(BE);

/* Which migrations does the running server tell an operator to run? */
const demanded = new Set();
for (const f of sources) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/migrations\/([0-9a-zA-Z._-]+\.js)/g)) demanded.add(m[1]);
}

const prep = fs.readFileSync(path.join(BE, "scripts", "prepareSmokeDb.cjs"), "utf8");
const built = new Set(
  [...prep.matchAll(/migrations",\s*"([0-9a-zA-Z._-]+\.js)"/g)].map((m) => m[1])
);

async function main() {
  console.log("the smoke preparation keeps up with the boot invariant");

  ok("the preparation runs some migrations at all", built.size > 0, `found ${built.size}`);
  ok("the server names some migrations in its refusals", demanded.size > 0, `found ${demanded.size}`);

  const missing = [...demanded].filter((m) => !built.has(m)).sort();
  ok(
    "every migration the server demands is built by the preparation",
    missing.length === 0,
    missing.length ? `prepareSmokeDb never runs: ${missing.join(", ")}` : ""
  );

  console.log("\n  the server demands:");
  for (const m of [...demanded].sort()) {
    console.log(`    ${built.has(m) ? "built  " : "MISSING"} ${m}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
