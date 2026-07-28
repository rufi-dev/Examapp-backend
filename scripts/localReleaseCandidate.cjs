"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

const backend = path.resolve(__dirname, "..");
const frontend = path.resolve(backend, "..", "Frontend");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;

function run(label, command, args, cwd, env = {}) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "inherit",
    // Node >= 20 refuses to spawn a Windows .cmd (npm.cmd) without a shell
    // (CVE-2024-27980) → spawnSync EINVAL. Use a shell ONLY for .cmd/.bat — never
    // for node.exe, whose path (C:\Program Files\...) would break under a shell.
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}`);
  }
}

function verifySbom(label, cwd) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(npm, ["run", "--silent", "sbom"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(npm), // .cmd needs a shell (see run()).
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    throw new Error(`${label} failed with exit ${result.status}`);
  }
  const bom = JSON.parse(result.stdout);
  if (bom.bomFormat !== "CycloneDX" || !Array.isArray(bom.components)) {
    throw new Error(`${label} did not produce a valid CycloneDX component list`);
  }
  console.log(`${label}: ${bom.components.length} production components`);
}

try {
  run("Backend full tests", npm, ["test"], backend);
  run("Backend lint/static", npm, ["run", "lint"], backend);
  run("Backend dependency gate", npm, ["run", "audit:ci"], backend);
  verifySbom("Backend SBOM", backend);

  run("Frontend Vitest", npm, ["test"], frontend);
  run("Frontend lint/accessibility rules", npm, ["run", "lint"], frontend);
  run(
    "Frontend production build and bundle budgets",
    npm,
    ["run", "build"],
    frontend,
    { VITE_BACKEND_URL: "https://api.examopia.com" }
  );
  run("Frontend dependency gate", npm, ["run", "audit:ci"], frontend);
  verifySbom("Frontend SBOM", frontend);

  const launcher = path.join("scripts", "e2eDisposable.cjs");
  run("Disposable app and accessibility E2E", node, [launcher, "--project=app"], backend);
  run(
    "Disposable HTTPS auth matrix",
    node,
    [launcher, "--project=auth-chromium", "--project=auth-firefox", "--project=auth-webkit"],
    backend
  );
  run(
    "Disposable private-PDF matrix",
    node,
    [launcher, "--project=pdf-chromium", "--project=pdf-firefox", "--project=pdf-webkit"],
    backend
  );
  run(
    "Production-build enforcing-header matrix",
    node,
    [launcher, "--project=headers-chromium", "--project=headers-firefox", "--project=headers-webkit"],
    backend
  );

  run("Backend diff check", "git", ["diff", "--check"], backend);
  run("Frontend diff check", "git", ["diff", "--check"], frontend);
  console.log("\nLOCAL RELEASE CANDIDATE PASSED");
} catch (error) {
  console.error(`\nLOCAL RELEASE CANDIDATE FAILED: ${error.message}`);
  process.exit(1);
}
