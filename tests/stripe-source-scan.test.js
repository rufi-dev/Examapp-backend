/*
 * STRIPE-removal (CR-100) — bounded SOURCE/CONFIG regression across the ENTIRE
 * shipping surface (backend + frontend), plus dependency + runtime proofs. It fails
 * on any ACTIVE Stripe reference — an import/require of `stripe`, an installed
 * dependency, `STRIPE_KEY`, a `/api/stripe` mount, `js.stripe.com` in CSP, a
 * checkout-session/`exam_purchase` contract, or the removed Stripe Redux module /
 * `payExam`.
 *
 * Scanned: backend controllers/routes/middleware/services/helper/utils/config/models/
 * jobs/migrations/scripts/server + package manifests & lockfile + .env.example + Docker
 * & deployment config (Dockerfile, docker-compose.yml, Caddyfile); frontend src/redux/
 * public + Vite/Vitest/Playwright/PostCSS/Tailwind config + package manifests & lockfile
 * + hosting config (_headers, vercel.json, manifest.json, index.html).
 *
 * DELIBERATELY EXCLUDED (not whole shipping dirs): *.test.* / *.spec.* files and the
 * clearly-labeled historical audit/remediation logs under docs/ — comment lines are
 * skipped so a labeled-historical note documenting the removal is allowed. Generic
 * words (`price`/`payment`) and the defensive `Permissions-Policy: payment=()`
 * directive are NOT matched. The live `.env`, if present, is inspected by KEY NAME
 * ONLY — its values are never read into a variable, logged, or emitted.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let passed = 0, failed = 0;
const ok = (n, c) => { if (c) { passed++; console.log("  ✓", n); } else { failed++; console.log("  ✗ FAIL:", n); } };

const BE = path.join(__dirname, "..");
const FE = path.join(BE, "..", "Frontend");
const P = (...a) => path.join(...a);

// Every SHIPPING source/config root (source + active config). Historical logs
// (docs/) and tests are excluded by walk(); the live .env is handled separately.
const ROOTS = [
  // backend source
  P(BE, "controllers"), P(BE, "routes"), P(BE, "middleware"), P(BE, "services"),
  P(BE, "helper"), P(BE, "utils"), P(BE, "config"), P(BE, "models"), P(BE, "jobs"),
  P(BE, "migrations"), P(BE, "scripts"), P(BE, "views"), P(BE, "server.js"),
  P(BE, "dev-local-db.js"),
  // backend manifests + deployment/config
  P(BE, "package.json"), P(BE, "package-lock.json"), P(BE, ".env.example"),
  P(BE, "Dockerfile"), P(BE, "docker-compose.yml"), P(BE, "Caddyfile"),
  // frontend source
  P(FE, "src"), P(FE, "redux"), P(FE, "public"), P(FE, "vite"), P(FE, "scripts"),
  // frontend build/test/hosting config + manifests
  P(FE, "vite.config.js"), P(FE, "vitest.config.js"), P(FE, "playwright.config.js"),
  P(FE, "postcss.config.js"), P(FE, "tailwind.config.js"), P(FE, "index.html"),
  P(FE, "manifest.json"), P(FE, "vercel.json"), P(FE, "package.json"),
  P(FE, "package-lock.json"),
];
const SCAN_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".json", ".mjs", ".cjs", ".yml", ".yaml", ".html", ".css", ""]);
const ALLOW_BASENAME = new Set(["_headers", "Dockerfile", "Caddyfile", ".env.example"]);
const SKIP_DIR = new Set(["node_modules", "tests", "dist", "build", ".git", "coverage", "docs", "test-results"]);
const isTestFile = (f) => /\.test\.|\.spec\./.test(f);

function walk(p, out) {
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) {
    if (SKIP_DIR.has(path.basename(p))) return;
    for (const e of fs.readdirSync(p)) walk(P(p, e), out);
  } else if (st.isFile()) {
    if (isTestFile(p)) return;
    const ext = path.extname(p);
    if (SCAN_EXT.has(ext) || ALLOW_BASENAME.has(path.basename(p))) out.push(p);
  }
}

// A line is a pure comment (JS `//` `/* *`, config `#`, or HTML `<!--`) — labeled text.
const isCommentLine = (line) => {
  const t = line.trim();
  return t === "" || t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--");
};

// ACTIVE Stripe patterns that must never appear on a shipping CODE line.
const FORBIDDEN = [
  { re: /(require\(\s*['"]stripe['"]|from\s+['"]stripe['"]|import\s+[^;\n]*['"]stripe['"])/, why: "import/require of stripe" },
  { re: /STRIPE_KEY/, why: "STRIPE_KEY" },
  { re: /\/api\/stripe/, why: "/api/stripe mount" },
  { re: /js\.stripe\.com/, why: "js.stripe.com CSP host" },
  // The removed CHECKOUT CONTRACT specifically — session creation/retrieval and the
  // `exam_purchase` JWT type. NOT the bare param names `session_id`/`exam_purchase`,
  // which the removal legitimately references in defensive strip/refuse handlers.
  { re: /checkout\.sessions|create-checkout-session|createCheckoutSession|stripe\.checkout|(typ|type)\s*:\s*['"]exam_purchase/, why: "checkout-session / exam_purchase JWT contract" },
  { re: /features\/stripe|stripeSlice|stripeService|\bpayExam\b/, why: "removed Stripe Redux module / payExam" },
  // A dependency-manifest entry that (re)installs the SDK.
  { re: /"stripe"\s*:\s*"/, why: "stripe dependency manifest entry" },
];

const files = [];
for (const r of ROOTS) walk(r, files);
ok(`scanned a broad shipping surface (${files.length} files across backend + frontend)`, files.length > 120);

const hits = [];
for (const f of files) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return;
    for (const { re, why } of FORBIDDEN) {
      if (re.test(line)) hits.push(`${path.relative(P(BE, ".."), f)}:${i + 1} [${why}] ${line.trim().slice(0, 100)}`);
    }
  });
}
if (hits.length) hits.forEach((h) => console.log("    ✗", h));
ok("no ACTIVE Stripe reference on any shipping code line", hits.length === 0);

// ── Live .env inspected by KEY NAME ONLY — values are never read or emitted. ──
const envPath = P(BE, ".env");
if (fs.existsSync(envPath)) {
  const names = fs.readFileSync(envPath, "utf8").split(/\r?\n/)
    .map((l) => (l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/) || [])[1]) // capture the NAME left of '=' only
    .filter(Boolean);
  const stripeNamed = names.filter((n) => /stripe/i.test(n));
  ok(`.env has no Stripe-named key (inspected ${names.length} key NAMES; values never read)`, stripeNamed.length === 0);
} else {
  ok(".env absent — nothing to inspect (name-only check vacuous)", true);
}

// ── Removed artifacts. ──
ok("controllers/stripeController.js absent", !fs.existsSync(P(BE, "controllers", "stripeController.js")));
ok("routes/stripeRoute.js absent", !fs.existsSync(P(BE, "routes", "stripeRoute.js")));
ok("Frontend/redux/features/stripe absent", !fs.existsSync(P(FE, "redux", "features", "stripe")));
ok("stripe not a backend package.json dependency", !/"stripe"\s*:/.test(fs.readFileSync(P(BE, "package.json"), "utf8")));
if (fs.existsSync(P(FE, "package.json"))) ok("stripe not a frontend package.json dependency", !/"stripe"\s*:/.test(fs.readFileSync(P(FE, "package.json"), "utf8")));
ok("stripe not installed (backend node_modules/stripe absent)", !fs.existsSync(P(BE, "node_modules", "stripe")));
ok("backend package-lock.json has no stripe entry", !/node_modules\/stripe|\/stripe\/-\/stripe|"stripe"\s*:/.test(fs.readFileSync(P(BE, "package-lock.json"), "utf8")));
if (fs.existsSync(P(FE, "package-lock.json"))) ok("frontend package-lock.json has no stripe entry", !/node_modules\/stripe|\/stripe\/-\/stripe|"stripe"\s*:/.test(fs.readFileSync(P(FE, "package-lock.json"), "utf8")));

// ── Dependency-tree proof: `npm ls stripe --all` resolves to nothing. ──
const ls = spawnSync("npm", ["ls", "stripe", "--all"], { cwd: BE, encoding: "utf8", shell: process.platform === "win32" });
const lsOut = `${ls.stdout || ""}${ls.stderr || ""}`;
ok("npm ls stripe --all is empty (no resolved stripe@ / node_modules/stripe)", /\(empty\)/.test(lsOut) || (!/stripe@\d/.test(lsOut) && !/node_modules[\/\\]stripe/.test(lsOut)));

// ── The defensive Permissions-Policy payment=() directive MUST be preserved. ──
for (const cfg of [P(FE, "public", "_headers"), P(FE, "vercel.json")]) {
  if (fs.existsSync(cfg)) ok(`Permissions-Policy payment=() preserved in ${path.basename(cfg)}`, /payment=\(\)/.test(fs.readFileSync(cfg, "utf8")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
