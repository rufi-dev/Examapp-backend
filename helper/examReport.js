// Generates an end-of-exam results report (Excel + PDF) and sends it to the
// exam's Telegram recipients (owner + linked admins). Triggered by the
// scheduler once an exam's endDate passes.
const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const {
  recipientsForExam,
  className,
  sendTelegramDocument,
  esc,
} = require("./telegram");

// Unicode font so Azerbaijani characters (ə, ş, ğ, ı, ç, ö, ü) render in the PDF
// (pdfkit's built-in fonts are WinAnsi-only and would mangle them).
const FONT_PATH = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans.ttf");

const fmtDateTime = (d) =>
  d
    ? new Date(d).toLocaleString("az-AZ", {
        timeZone: "Asia/Baku",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function computeStats(exam, results) {
  const scores = results.map((r) => Number(r.earnPoints || 0));
  const n = scores.length;
  const sum = scores.reduce((a, b) => a + b, 0);
  const pm = exam.passingMarks != null ? Number(exam.passingMarks) : null;
  return {
    n,
    avg: n ? Math.round((sum / n) * 10) / 10 : 0,
    high: n ? Math.max(...scores) : 0,
    low: n ? Math.min(...scores) : 0,
    pass: pm != null ? scores.filter((s) => s >= pm).length : null,
    total: exam.totalMarks != null ? Number(exam.totalMarks) : null,
    passingMarks: pm,
  };
}

const rowsSorted = (results) =>
  [...results].sort((a, b) => Number(b.earnPoints || 0) - Number(a.earnPoints || 0));

// ---- Excel ------------------------------------------------------------------
async function buildResultsExcel(exam, results, cname, stats) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Imtahan Platforması";

  const s1 = wb.addWorksheet("Xülasə");
  s1.columns = [
    { width: 26 },
    { width: 40 },
  ];
  const meta = [
    ["İmtahan", exam.name || "—"],
    ["Sinif", cname || "—"],
    ["Bitmə tarixi", fmtDateTime(exam.endDate)],
    ["İştirakçı sayı", stats.n],
    ["Orta bal", stats.avg],
    ["Ən yüksək", stats.high],
    ["Ən aşağı", stats.low],
    ["Keçid balı", stats.passingMarks != null ? stats.passingMarks : "—"],
    ["Keçən sayı", stats.pass != null ? `${stats.pass}/${stats.n}` : "—"],
  ];
  meta.forEach(([k, v]) => {
    const row = s1.addRow([k, v]);
    row.getCell(1).font = { bold: true };
  });

  const s2 = wb.addWorksheet("Nəticələr");
  s2.columns = [
    { header: "#", key: "i", width: 5 },
    { header: "Ad Soyad", key: "name", width: 28 },
    { header: "Email", key: "email", width: 28 },
    { header: "Telefon", key: "phone", width: 16 },
    { header: "Bal", key: "pts", width: 8 },
    { header: "Faiz", key: "pct", width: 8 },
    { header: "Status", key: "status", width: 12 },
    { header: "Pozuntu", key: "vio", width: 9 },
    { header: "Tarix", key: "date", width: 20 },
  ];
  s2.getRow(1).font = { bold: true };
  rowsSorted(results).forEach((r, idx) => {
    const pts = Number(r.earnPoints || 0);
    const pct = stats.total ? Math.round((pts / stats.total) * 100) : null;
    const passed = stats.passingMarks != null ? pts >= stats.passingMarks : null;
    s2.addRow({
      i: idx + 1,
      name: r.userId?.name || "—",
      email: r.userId?.email || "",
      phone: r.userId?.phone || "",
      pts,
      pct: pct != null ? `${pct}%` : "—",
      status: passed === null ? "—" : passed ? "Keçdi" : "Keçmədi",
      vio: Number(r.violations || 0),
      date: fmtDateTime(r.createdAt),
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// ---- PDF --------------------------------------------------------------------
function buildResultsPdf(exam, results, cname, stats) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 44, size: "A4" });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      doc.registerFont("dv", FONT_PATH);
      doc.registerFont("dvb", FONT_PATH); // same file; we fake "bold" via size
      doc.font("dv");

      doc.fontSize(18).text("İmtahan hesabatı", { align: "left" });
      doc.moveDown(0.3);
      doc.fontSize(11);
      doc.text(`İmtahan: ${exam.name || "—"}`);
      if (cname) doc.text(`Sinif: ${cname}`);
      doc.text(`Bitmə: ${fmtDateTime(exam.endDate)}`);
      doc.moveDown(0.4);
      doc
        .fontSize(10)
        .text(
          `İştirakçı: ${stats.n}   •   Orta: ${stats.avg}   •   Ən yüksək: ${stats.high}   •   Ən aşağı: ${stats.low}` +
            (stats.pass != null ? `   •   Keçən: ${stats.pass}/${stats.n}` : "")
        );
      doc.moveDown(0.6);

      // Table header
      const left = doc.page.margins.left;
      const colX = { rank: left, name: left + 34, pts: left + 300, pct: left + 360, st: left + 420 };
      const headerY = doc.y;
      doc.fontSize(10);
      doc.text("#", colX.rank, headerY);
      doc.text("Ad Soyad", colX.name, headerY);
      doc.text("Bal", colX.pts, headerY);
      doc.text("Faiz", colX.pct, headerY);
      doc.text("Status", colX.st, headerY);
      doc.moveTo(left, doc.y + 2).lineTo(doc.page.width - left, doc.y + 2).stroke();
      doc.moveDown(0.5);

      rowsSorted(results).forEach((r, idx) => {
        const pts = Number(r.earnPoints || 0);
        const pct = stats.total ? Math.round((pts / stats.total) * 100) : null;
        const passed = stats.passingMarks != null ? pts >= stats.passingMarks : null;
        if (doc.y > doc.page.height - 60) doc.addPage().font("dv");
        const y = doc.y;
        doc.fontSize(10);
        doc.text(String(idx + 1), colX.rank, y, { width: 28 });
        doc.text(r.userId?.name || "—", colX.name, y, { width: 250, ellipsis: true });
        doc.text(String(pts), colX.pts, y, { width: 52 });
        doc.text(pct != null ? `${pct}%` : "—", colX.pct, y, { width: 52 });
        doc.text(
          passed === null ? "—" : passed ? "Keçdi" : "Keçmədi",
          colX.st,
          y,
          { width: 80 }
        );
        doc.moveDown(0.4);
      });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// Generate both docs and send them to the exam's recipients.
async function sendExamReport(exam, results) {
  const recips = await recipientsForExam(exam, "onReport");
  if (!recips.length) return { sent: 0 };

  const cname = await className(exam);
  const stats = computeStats(exam, results);
  const xlsx = await buildResultsExcel(exam, results, cname, stats);
  const pdf = await buildResultsPdf(exam, results, cname, stats);

  const slug =
    String(exam.name || "imtahan")
      .replace(/[^\w]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40) || "imtahan";
  const caption = [
    "📊 <b>İmtahan hesabatı</b>",
    `📝 ${esc(exam.name || "İmtahan")}${cname ? ` · 🏫 ${esc(cname)}` : ""}`,
    `👥 İştirakçı: ${stats.n}`,
    `📈 Orta: ${stats.avg} · Ən yüksək: ${stats.high} · Ən aşağı: ${stats.low}` +
      (stats.pass != null ? ` · ✅ Keçən: ${stats.pass}/${stats.n}` : ""),
    `🕒 Bitmə: ${esc(fmtDateTime(exam.endDate))}`,
    "📎 PDF + Excel əlavə olunub",
  ].join("\n");

  let sent = 0;
  let failed = 0;
  for (const chatId of recips) {
    const a = await sendTelegramDocument(chatId, xlsx, `${slug}.xlsx`, caption);
    const b = await sendTelegramDocument(chatId, pdf, `${slug}.pdf`);
    if (a?.ok && b?.ok) sent += 1;
    else failed += 1;
  }
  return { sent, failed };
}

module.exports = { buildResultsExcel, buildResultsPdf, sendExamReport, computeStats };
