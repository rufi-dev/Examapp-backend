/* Stripe Billing contract: plan billing is active, exam purchase payments remain retired, and no credential is committed. */
const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
const ok = (name, condition) => {
  if (condition) { passed += 1; console.log("  ✓", name); }
  else { failed += 1; console.log("  ✗ FAIL:", name); }
};

const BE = path.join(__dirname, "..");
const FE = path.join(BE, "..", "Frontend");
const read = (file) => fs.readFileSync(file, "utf8");
const server = read(path.join(BE, "server.js"));
const packageJson = JSON.parse(read(path.join(BE, "package.json")));

ok("Stripe SDK is installed for server-side Billing", !!packageJson.dependencies?.stripe);
ok("Billing controller exists", fs.existsSync(path.join(BE, "controllers", "stripeBillingController.js")));
ok("Billing route exists", fs.existsSync(path.join(BE, "routes", "stripeBillingRoute.js")));
ok("Stripe webhook is mounted before JSON parsing", server.indexOf("stripe/webhook") < server.indexOf("app.use(express.json())"));
ok("legacy exam-payment route is not mounted", !/app\.use\(["']\/api\/stripe/.test(server));
ok("frontend billing client exists", fs.existsSync(path.join(FE, "src", "helper", "planApi.js")));

const roots = [path.join(BE, "controllers"), path.join(BE, "routes"), path.join(BE, "config"), path.join(BE, "models"), path.join(FE, "src")];
const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (/\.(js|jsx|ts|tsx|json|yml|yaml)$/.test(name)) files.push(file);
  }
};
roots.forEach((root) => { if (fs.existsSync(root)) walk(root); });
const source = files.map(read).join("\n");
ok("no live or test Stripe secret is committed", !/sk_(?:live|test)_[A-Za-z0-9]+/.test(source));
ok("no Stripe webhook secret is committed", !/whsec_[A-Za-z0-9]+/.test(source));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
