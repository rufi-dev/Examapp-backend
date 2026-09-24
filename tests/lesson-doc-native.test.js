/* eslint-env node */
const assert = require("assert");
const {
  NATIVE_SCHEMA,
  NATIVE_SYSTEM,
  normalizeNative,
  nativeBlocksToHtml,
  diagramSvg,
  nativePrintOptions,
} = require("../helper/lessonDocNative");
const { sanitizeDocHtml } = require("../helper/lessonDocSanitize");

assert.strictEqual(NATIVE_SCHEMA.properties.blocks.maxItems, 36);
assert.ok(NATIVE_SYSTEM.includes("HTML, CSS, SVG"));

const doc = normalizeNative({
  title: "Faizlər",
  audience: "7-ci sinif",
  reply: "Hazırdır",
  blocks: [
    { kind: "heading", text: "Faiz nədir?" },
    { kind: "text", text: "Faiz yüzdə bir hissədir." },
    { kind: "example", text: "200-ün 10%-i", solution: "20" },
    { kind: "table", columns: ["Hissə", "Nəticə"], rows: [["10%", "20"]] },
    { kind: "diagram", text: "", diagram: { type: "bars", title: "Nümunə", labels: ["10", "20"], values: [1, 2] } },
  ],
});
const html = sanitizeDocHtml(nativeBlocksToHtml(doc));
assert.ok(html.includes("Faiz nədir?"));
assert.ok(html.includes("<svg"));
assert.ok(html.includes("Hissə"));
assert.ok(!html.includes("<script"));
assert.ok(!html.includes("<style"));
assert.ok(diagramSvg(doc.blocks[4].diagram).includes("viewBox"));
assert.strictEqual(doc.blocks.length, 5);
assert.deepStrictEqual(nativePrintOptions("səhifə nömrələrini göstər"), { pageNumbers: true });
assert.deepStrictEqual(nativePrintOptions("səhifə nömrəsi olmasın"), { pageNumbers: false });
// Only what was asked for: naming a colour must not switch page numbers on too.
assert.deepStrictEqual(nativePrintOptions("materialın rəngini yaşıl et"), { accent: "green" });
assert.strictEqual(nativePrintOptions("faiz mövzusunu izah et"), null);

console.log("lesson-doc-native: all assertions passed");
