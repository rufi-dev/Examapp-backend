/*
 * The pictures a question carries, fetched back so the AI can look at them.
 *
 * A teacher's paper is not all text. They attach a Venn diagram, a bar chart, a
 * photograph of a table — and until now the answer key was decided without ever
 * seeing any of it, which is how a question whose numbers live only in a chart
 * came back marked with a guess.
 *
 * The images live on an image host as URLs, so answering them means the SERVER
 * fetching a URL the browser supplied. That is a request forgery waiting to
 * happen: a crafted `image` field pointing at 169.254.169.254 or at something
 * inside the private network would be fetched by us, with our network position,
 * and its bytes handed to a model. So this is deliberately narrow:
 *
 *   - https only, and only hosts on the allow-list (the image CDN we upload to),
 *   - a bounded number of files and a bounded total size,
 *   - a short timeout, and any failure is skipped rather than fatal,
 *   - image content types only.
 *
 * Everything it cannot vouch for is left out. A missing picture means a question
 * the model declines to answer, which is the safe direction: the caller's
 * backstop leaves it blank for the teacher rather than guessing.
 */
const ALLOWED_HOSTS = String(process.env.AI_FIGURE_HOSTS || "res.cloudinary.com")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const MAX_FIGURES = Number(process.env.AI_FIGURE_MAX_FILES) || 20;
const MAX_BYTES_EACH = Number(process.env.AI_FIGURE_MAX_BYTES) || 6 * 1024 * 1024;
const MAX_BYTES_TOTAL = Number(process.env.AI_FIGURE_MAX_TOTAL) || 24 * 1024 * 1024;
const FETCH_TIMEOUT_MS = Number(process.env.AI_FIGURE_TIMEOUT_MS) || 10_000;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

/* A URL we are willing to fetch on the teacher's behalf, or null. */
function safeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s || s.startsWith("data:")) return null; // a data URI is already inline
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return null;
  return u.toString();
}

/*
 * Every distinct picture in a paper, in question order, each tagged with the
 * question it belongs to so the prompt can say "this picture is question 9's".
 * Without that tag a model handed twelve loose images has to guess the pairing,
 * which is a new way to get the same question wrong.
 */
function figureUrls(questions) {
  const seen = new Map(); // url -> the first question number that used it
  (Array.isArray(questions) ? questions : []).forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const urls = [q.image, ...(Array.isArray(q.images) ? q.images : [])];
    for (const c of Array.isArray(q.choices) ? q.choices : []) urls.push(c?.image);
    for (const raw of urls) {
      const ok = safeUrl(raw);
      if (ok && !seen.has(ok)) seen.set(ok, i + 1);
    }
  });
  return [...seen.entries()].slice(0, MAX_FIGURES).map(([url, forQuestion]) => ({ url, forQuestion }));
}

async function fetchOne(url, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return null;
    const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) return null;
    const declared = Number(res.headers.get("content-length") || 0);
    if (declared && declared > MAX_BYTES_EACH) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES_EACH) return null;
    return { buf, mime: type === "image/jpg" ? "image/jpeg" : type };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/*
 * The figures as provider-ready parts, plus a note naming which question each
 * one belongs to and which ones could not be fetched.
 */
async function collectFigures(questions, { signal } = {}) {
  const wanted = figureUrls(questions);
  if (!wanted.length) return { parts: [], labels: [], missing: 0 };

  const got = await Promise.all(wanted.map((w) => fetchOne(w.url, signal)));

  const parts = [];
  const labels = [];
  let total = 0;
  let missing = 0;
  got.forEach((r, i) => {
    if (!r) {
      missing += 1;
      return;
    }
    if (total + r.buf.length > MAX_BYTES_TOTAL) {
      missing += 1;
      return;
    }
    total += r.buf.length;
    const n = wanted[i].forQuestion;
    parts.push({
      name: `sual-${n}-${parts.length + 1}.${r.mime.split("/")[1]}`,
      data: r.buf.toString("base64"),
      mime: r.mime,
      isPdf: false,
    });
    labels.push(`${parts.length}-ci şəkil → ${n}-ci sual`);
  });

  return { parts, labels, missing };
}

module.exports = {
  collectFigures,
  figureUrls,
  safeUrl,
  ALLOWED_HOSTS,
  MAX_FIGURES,
  MAX_BYTES_EACH,
  MAX_BYTES_TOTAL,
};
