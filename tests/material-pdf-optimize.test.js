const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  BACKUP_SUFFIX,
  isLinearizedPdf,
  recoverInterruptedPdfOptimization,
  linearizePdfAtomic,
  ensureMaterialPdfOptimized,
} = require("../utils/materialPdfOptimize");

let passed = 0;
const ok = (condition, message) => {
  assert.ok(condition, message);
  passed += 1;
};

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "exq-material-pdf-"));
  try {
    const source = path.join(root, "material.pdf");
    const original = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
    fs.writeFileSync(source, original);
    ok(!isLinearizedPdf(source), "ordinary PDF starts non-linearized");

    let calls = 0;
    const fakeLinearizer = async (_src, target) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      fs.writeFileSync(
        target,
        Buffer.from("%PDF-1.7\n1 0 obj\n<</Linearized 1>>\nendobj\n%%EOF\n")
      );
      return true;
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureMaterialPdfOptimized(source, { linearizer: fakeLinearizer })
      )
    );
    ok(calls === 1, "concurrent opens share one optimization job");
    ok(
      results.every((result) => result.ok),
      "all concurrent readers receive a ready PDF"
    );
    ok(isLinearizedPdf(source), "optimized file carries the web-view header");

    const again = await ensureMaterialPdfOptimized(source, {
      linearizer: fakeLinearizer,
    });
    ok(again.ok && !again.changed, "ready file is reused without a rewrite");
    ok(calls === 1, "ready file never invokes the optimizer again");

    const corrupt = path.join(root, "corrupt.pdf");
    fs.writeFileSync(corrupt, original);
    const before = fs.readFileSync(corrupt);
    const failed = await linearizePdfAtomic(corrupt, {
      linearizer: async (_src, target) => {
        fs.writeFileSync(target, Buffer.from("not a PDF"));
        return true;
      },
    });
    ok(!failed.ok, "invalid optimizer output is refused");
    ok(
      fs.readFileSync(corrupt).equals(before),
      "a failed optimization preserves original bytes"
    );
    ok(
      fs.readdirSync(root).every((name) => !name.endsWith(".linearized.tmp")),
      "temporary derivatives are cleaned"
    );

    const interrupted = path.join(root, "interrupted.pdf");
    fs.writeFileSync(`${interrupted}${BACKUP_SUFFIX}`, original);
    ok(
      recoverInterruptedPdfOptimization(interrupted),
      "an interrupted replacement restores its durable backup"
    );
    ok(
      fs.readFileSync(interrupted).equals(original),
      "recovery preserves the original PDF bytes"
    );
    ok(
      !fs.existsSync(`${interrupted}${BACKUP_SUFFIX}`),
      "recovery consumes the backup after restoration"
    );

    console.log(`material-pdf-optimize: ${passed}/${passed} passed`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
