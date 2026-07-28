const path = require("path");
// nodemailer-express-handlebars 7 is ESM (default export); ≤6 was a bare function.
const hbsMod = require("nodemailer-express-handlebars");
const hbs = hbsMod.default || hbsMod;
const {
  resolveKind, createMailTransporter, resolveFrontendLink, assertBoundedCode,
  assertNoHeaderInjection,
} = require("./mailConfig");

// CR-107/CR-108 — stable, low-cardinality counters (no PII / content ever logged).
const mailMetrics = { disabledSkipped: 0, sent: 0, failed: 0 };

// The hbs "compile" plugin, configured to render ONLY from ./views and to NEVER let
// a template read the filesystem or fetch URLs.
function compilePlugin() {
  return hbs({
    viewEngine: { extName: ".handlebars", partialsDir: path.resolve("./views"), defaultLayout: false },
    viewPath: path.resolve("./views"),
    extName: ".handlebars",
  });
}

/*
 * Typed, SERVER-OWNED notification sender. `kind` selects an allowlisted template;
 * the recipient, subject, replyTo, name and link/code are ALL server-derived and
 * validated here (allowlisted template, same-origin link or bounded code, no CR/LF
 * header injection). A caller can never choose a template, subject or arbitrary link.
 */
async function sendNotification({ kind, to, subject, replyTo, name, link, code } = {}) {
  if (process.env.EMAIL_ENABLED !== "true") {
    mailMetrics.disabledSkipped += 1;
    console.log("[mail] send skipped (EMAIL_ENABLED!=true)"); // stable event, NO subject/recipient
    return { skipped: true };
  }

  const spec = resolveKind(kind); // throws on unknown/hostile kind BEFORE any FS lookup
  const from = process.env.EMAIL_USER;
  const safeName = typeof name === "string" ? name.slice(0, 200) : "";

  // Per-kind link/context handling: same-origin URL, bounded code, or none.
  let context;
  if (spec.link === "url") context = { name: safeName, link: resolveFrontendLink(link) };
  else if (spec.link === "code") context = { name: safeName, link: assertBoundedCode(code != null ? code : link) };
  else context = { name: safeName };

  // Reject CR/LF (header injection) in every header/address field.
  assertNoHeaderInjection({ to, subject, replyTo, from });

  const transporter = createMailTransporter();
  transporter.use("compile", compilePlugin());

  try {
    const info = await transporter.sendMail({
      from: { name: process.env.EMAIL_FROM_NAME || "Examopia", address: from },
      to,
      replyTo: replyTo || from,
      subject,
      template: spec.template,
      context,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    mailMetrics.sent += 1;
    return info;
  } catch (err) {
    mailMetrics.failed += 1;
    throw err;
  }
}

module.exports = { sendNotification, mailMetrics };
