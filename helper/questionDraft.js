/*
 * The question the AI is writing right now, read out of its half-finished
 * answer, so the builder can show "3-cü sual yazılır: …" while it happens.
 *
 * A finished question is sent as its own event by the streamer in the
 * controller; this only looks at the object still open at the end of the
 * buffer. It returns its position (1-based) and the stem written so far, or
 * null while no question has begun. It never throws: the buffer is, by
 * definition, broken JSON.
 */

// The value of the first "text" key in an open object, unescaped as far as written.
function stemOf(obj) {
  const m = /"text"\s*:\s*"/.exec(obj);
  if (!m) return "";
  let out = "";
  for (let i = m.index + m[0].length; i < obj.length; i += 1) {
    const c = obj[i];
    if (c === "\\") {
      const n = obj[i + 1];
      if (n === undefined) break; // the escape itself is not written yet
      out += n === "n" || n === "t" || n === "r" ? " " : n === "u" ? "" : n;
      i += n === "u" ? 5 : 1;
      continue;
    }
    if (c === '"') break;
    out += c;
  }
  return out.replace(/\s+/g, " ").trim();
}

function currentQuestionDraft(buf) {
  const text = String(buf || "");
  const qk = text.indexOf('"questions"');
  if (qk < 0) return null;
  const arrStart = text.indexOf("[", qk);
  if (arrStart < 0) return null;
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  let started = 0;
  for (let i = arrStart + 1; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) {
        objStart = i;
        started += 1;
      }
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) objStart = -1;
    } else if (c === "]" && depth === 0) {
      return null; // the list is closed: nothing is being written
    }
  }
  if (depth <= 0 || objStart < 0) return null;
  return { n: started, text: stemOf(text.slice(objStart)) };
}

module.exports = { currentQuestionDraft };
