"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const roots = [
  "config",
  "controllers",
  "helper",
  "jobs",
  "middleware",
  "migrations",
  "models",
  "routes",
  "scripts",
  "services",
  "utils",
];
const files = [path.join(root, "server.js"), path.join(root, "worker.js")];

function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (entry.isFile() && /\.(?:c?js)$/.test(entry.name)) files.push(absolute);
  }
}
for (const directory of roots) walk(path.join(root, directory));

const failures = [];
const large = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/).length;
  if (lines > 1000) large.push({ file: path.relative(root, file), lines });
  if (/^(?:<{7}|={7}|>{7})/m.test(source)) {
    failures.push(`${path.relative(root, file)}: conflict marker`);
  }
  /*
   * A control character in source is always an accident, and a silent one.
   *
   * One got into a regex — `\b` written as a literal BACKSPACE (0x08) — and
   * the pattern then required a control character in the middle of HTML, so
   * it matched nothing at all. Every lesson material reported "0 parts" for
   * days. It parses, it lints, it reads correctly in an editor and in a
   * terminal, because a backspace prints as nothing. Only the bytes show it.
   *
   * Tab, newline and carriage return are legitimate; nothing else is.
   */
  // eslint-disable-next-line no-control-regex
  const control = source.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/);
  if (control) {
    const at = source.indexOf(control[0]);
    const line = source.slice(0, at).split(/\r?\n/).length;
    const code = `0x${control[0].charCodeAt(0).toString(16).padStart(2, "0")}`;
    failures.push(
      `${path.relative(root, file)}:${line}: control character ${code} in source — ` +
        `an escape (\\b, \\0, \\f) was written as the character itself`
    );
  }
  const checked = spawnSync(process.execPath, ["--check", file], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (checked.status !== 0) {
    failures.push(
      `${path.relative(root, file)}: ${String(checked.stderr || checked.stdout).trim()}`
    );
  }
}

const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
if (/^(?!\s*\/\/).*express\.static\s*\(\s*["']uploads["']/m.test(server)) {
  failures.push("server.js: public uploads static mount is forbidden");
}

if (large.length) {
  console.warn("Responsibility-size warning (non-blocking):");
  for (const item of large.sort((a, b) => b.lines - a.lines)) {
    console.warn(`  ${item.file}: ${item.lines} lines`);
  }
}
if (failures.length) {
  for (const failure of failures) console.error(`STATIC CHECK FAILED: ${failure}`);
  process.exit(1);
}
console.log(`Static check passed: ${files.length} shipping JavaScript files`);
