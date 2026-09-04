/*
 * Does every row of this table reach the end of the table?
 *
 * WHY THIS IS A CHECK AND NOT AN INSTRUCTION. Asked to duplicate a timetable
 * exactly, the model dropped the empty cells — the weeks with no lecture — and
 * every date after them slid left. The result was not a formatting blemish: it
 * moved a lecture into a month it does not happen in, and it read as authoritative
 * because everything else on the page was right. An empty cell in a timetable is a
 * statement that nothing happens that week, so losing one changes the meaning of
 * the document while leaving no trace that anything was lost.
 *
 * Writing "do not drop empty cells" into the brief is a wish. A short row, on the
 * other hand, is a fact about the markup: it is arithmetic, it needs no source to
 * compare against, and it can be handed back to the model as a tool error to fix
 * inside the same turn. That is the difference between asking and checking.
 *
 * Not every ragged table is wrong — a heading strip above a grid legitimately has
 * one cell — so this reports the rows that disagree with the table's OWN dominant
 * width, and reports nothing at all for a table with no dominant width.
 */

// Cells occupy a grid, and a rowspan from three rows up still takes its column in
// this one. Anything less than a real grid walk miscounts every merged table.
function rowWidths(table) {
  const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const carried = []; // remaining rowspan depth, per column
  const widths = [];

  for (const row of rows) {
    const cells = row.match(/<t[hd]\b[^>]*>/gi) || [];
    let col = 0;
    let used = 0;

    const step = () => {
      // Walk past columns still occupied by a rowspan started above.
      while (carried[col] > 0) {
        carried[col] -= 1;
        used += 1;
        col += 1;
      }
    };

    for (const cell of cells) {
      step();
      const num = (attr) => {
        const m = cell.match(new RegExp(`${attr}\\s*=\\s*["']?(\\d{1,3})`, "i"));
        const n = m ? parseInt(m[1], 10) : 1;
        return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 1;
      };
      const span = num("colspan");
      const down = num("rowspan") - 1;
      for (let i = 0; i < span; i += 1) {
        if (down > 0) carried[col + i] = down;
      }
      col += span;
      used += span;
    }

    step(); // trailing rowspans past the last written cell
    widths.push(used);
  }

  return widths;
}

// The width most rows agree on. A table with no majority is not a grid, and this
// check has nothing to say about it.
function dominant(widths) {
  const counts = new Map();
  widths.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  let best = 0;
  let bestN = 0;
  for (const [w, n] of counts) {
    if (n > bestN || (n === bestN && w > best)) {
      best = w;
      bestN = n;
    }
  }
  return bestN > widths.length / 2 ? best : 0;
}

const label = (row) => {
  const first = (row.match(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/i) || [])[1] || "";
  const text = first.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  return text ? `"${text.slice(0, 40)}"` : "(boş xana ilə başlayır)";
};

/*
 * Returns a message naming every short row, or "" when the document is sound.
 * Written for the model to act on: which table, which row, how many cells are
 * missing, and — because this is the mistake it actually makes — that the fix is
 * empty cells rather than wider ones.
 */
function checkTables(html) {
  const tables = String(html || "").match(/<table\b[\s\S]*?<\/table>/gi) || [];
  const problems = [];

  tables.forEach((table, ti) => {
    const widths = rowWidths(table);
    const width = dominant(widths);
    if (!width) return;

    const rows = table.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
    widths.forEach((w, ri) => {
      if (w === width) return;
      problems.push(
        `${ti + 1}-ci cədvəl, ${ri + 1}-ci sətir ${label(rows[ri] || "")}: ` +
          `${w} xana var, ${width} olmalıdır (${w < width ? `${width - w} xana əskikdir` : `${w - width} xana artıqdır`}).`
      );
    });
  });

  if (!problems.length) return "";

  return [
    "CƏDVƏL SƏHVDİR — sətirlər cədvəlin sonuna çatmır:",
    ...problems.slice(0, 12),
    problems.length > 12 ? `... və daha ${problems.length - 12} sətir.` : "",
    "",
    "Əskik xanaları BOŞ <td></td> kimi əlavə et. Boş xana mənadır: mənbədə o həftə",
    "dərs yoxdur deməkdir. Xananı silmək və ya qonşu xananı genişləndirmək dərsi",
    "başqa aya sürüşdürür və sənədin mənasını dəyişir.",
    "write_material-ı düzəldilmiş HTML ilə yenidən çağır.",
  ]
    .filter(Boolean)
    .join("\n");
}

module.exports = { checkTables, rowWidths, dominant };
