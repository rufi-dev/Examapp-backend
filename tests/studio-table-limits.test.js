/* eslint-env node */
/*
 * A school's ordinary table fits in Lesson Studio, and a schema handed back is
 * not a material.
 *
 * 11 Oct 2026, Gülanə Məmmədova, a 6th-grade KSQ/BSQ date sheet:
 *   "BSQ 1-dən sonra KSQ 4,5,6,7,8, sonda BSQ 2" → stopped at KSQ 6: a table
 *   had 8 columns at most.
 *   18 subjects → split into a second table with a repeated header: 12 rows at
 *   most. Every "remove the second one" then deleted the wrong thing.
 *   "Fənnlər qalsın" and "…fənnlərini əlavə elə" (both past 12 rows) came back
 *   from the CLI as the JSON schema itself, and the page said "Materialın
 *   məzmunu tam qayıtmadı".
 */
process.env.NODE_ENV = "test";

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

const N = require("../helper/lessonDocNative");
const C = require("../helper/cliAi");

const COLUMNS = ["Fənn", "KSQ 1", "KSQ 2", "KSQ 3", "BSQ 1", "KSQ 4", "KSQ 5", "KSQ 6", "KSQ 7", "KSQ 8", "BSQ 2"];
const SUBJECTS = [
  "Azərbaycan dili", "Ədəbiyyat", "Riyaziyyat", "Alman dili", "Rus dili", "İnformatika",
  "Azərbaycan tarixi", "Ümumi tarix", "Coğrafiya", "Təbiət",
  "Texnologiya", "Təsviri incəsənət", "Musiqi", "Fiziki tərbiyə",
];
const table = { kind: "table", text: "", columns: COLUMNS, rows: SUBJECTS.map((s) => [s, ...COLUMNS.slice(1).map(() => "")]) };
const raw = {
  title: "6-cı sinif üzrə KSQ və BSQ tarixləri cədvəli",
  blocks: [{ kind: "heading", text: "6-cı sinif KSQ və BSQ tarixləri" }, { kind: "text", text: "Tarixləri qeyd edin." }, table],
};

console.log("her table fits");
const tableSchema = N.NATIVE_SCHEMA.properties.blocks.items.properties;
ok("the schema allows 12 columns", tableSchema.columns.maxItems === 12 && tableSchema.rows.items.maxItems === 12);
ok("...and 40 rows", tableSchema.rows.maxItems === 40);
const content = N.salvageNative(N.normalizeNative(raw));
const t = content.blocks.find((b) => b.kind === "table");
ok("all 11 columns survive the cleanup", t && t.columns.length === 11, t && t.columns.join(","));
ok("KSQ 7, KSQ 8 and BSQ 2 are there, in order", t && t.columns.slice(-3).join(",") === "KSQ 7,KSQ 8,BSQ 2");
ok("all 14 subjects survive, in one table", t && t.rows.length === 14 && content.blocks.filter((b) => b.kind === "table").length === 1);
ok("every row keeps its 11 (empty) cells", t && t.rows.every((r) => r.length === 11));
const html = N.nativeBlocksToHtml(content);
ok("the page prints every header", (html.match(/<th>/g) || []).length === 11);
ok("...and every subject", SUBJECTS.every((s) => html.includes(s)));
const wide = N.normalizeNative({ title: "x", blocks: [{ kind: "heading", text: "h" }, { kind: "table", columns: Array.from({ length: 20 }, (_, i) => `c${i}`), rows: Array.from({ length: 60 }, () => Array(20).fill("v")) }] });
const wt = wide.blocks.find((b) => b.kind === "table");
ok("a table past the caps is still bounded", wt.columns.length === 12 && wt.rows.length === 40 && wt.rows[0].length === 12);
const list = N.normalizeNative({ title: "x", blocks: [{ kind: "list", items: SUBJECTS }] }).blocks[0];
ok("a list of her 14 subjects is kept whole", list.items.length === 14);

console.log("\na schema handed back is not an answer");
ok("her two failed turns' answer reads as a schema echo", C.isSchemaEcho(N.NATIVE_SCHEMA, N.NATIVE_SCHEMA));
ok("the exact shape the log recorded", C.isSchemaEcho({ type: "object", additionalProperties: false, properties: {}, required: [] }, N.NATIVE_SCHEMA));
ok("a real material is not", !C.isSchemaEcho(raw, N.NATIVE_SCHEMA));
ok("a real exam answer is not", !C.isSchemaEcho({ questions: [] }, { type: "object", properties: { questions: {} }, required: ["questions"] }));
ok("nothing at all is not", !C.isSchemaEcho(null, N.NATIVE_SCHEMA) && !C.isSchemaEcho([], N.NATIVE_SCHEMA));
ok("the retry says what went wrong", /SXEMİN ÖZÜNÜ QAYTARDIN/.test(C.buildSystemPrompt({ insist: "echo" })));
ok("a prose answer still gets its own retry message", /ÖNCƏKİ CAVAB JSON DEYİLDİ/.test(C.buildSystemPrompt({ insist: true })) && !/SXEMİN/.test(C.buildSystemPrompt({ insist: true })));
ok("a first attempt carries no retry line", !/ÖNCƏKİ/.test(C.buildSystemPrompt({})));

const src = fs.readFileSync(path.join(__dirname, "..", "helper", "cliAi.js"), "utf8");
ok("an echo fails as unreadable JSON, so the next route takes over", /if \(isSchemaEcho\(parsed, schema\)\) \{\s*throw Object\.assign\(new Error\("cli_invalid_json"\), \{ code: "cli_invalid_json", echo: true/.test(src));
ok("...after one pointed retry", /doc = await attempt\(e\.echo \? "echo" : true\)/.test(src));
ok("the prompt says the schema is a shape to fill", /bu, cavabın FORMASIDIR — onu təkrarlama, onu məzmunla DOLDUR/.test(src));
ok("cli_invalid_json is still a route defect", /"cli_invalid_json",/.test(fs.readFileSync(path.join(__dirname, "..", "helper", "aiRuntime.js"), "utf8")));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
