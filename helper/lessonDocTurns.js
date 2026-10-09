/*
 * Which materials have an AI turn running right now.
 *
 * A turn goes on after the page that started it is gone: the teacher leaves to
 * the library, comes back, and the material looks idle while the model is still
 * writing it. Nothing recorded the turn, so the reopened page offered the
 * composer as if nothing were happening, the teacher asked again, and the second
 * turn ran for a minute and a half against the version from before the first one
 * saved, then failed as a "conflict" (Ayten Məmmədova, 9 Oct 2026).
 *
 * So a turn is registered while it runs. The page reads it on load and waits;
 * a second turn on the same material is refused before anything is stored or
 * charged. In memory: turns run in this one process, and a restart ends them
 * anyway. A stale entry (a turn longer than any timeout) is ignored.
 */
const RUNNING = new Map(); // docId -> { token, since, text }
const STALE_MS = Math.max(60_000, Number(process.env.LESSON_DOC_TURN_STALE_MS) || 20 * 60_000);

function runningTurn(docId) {
  const key = String(docId);
  const r = RUNNING.get(key);
  if (!r) return null;
  if (Date.now() - r.since > STALE_MS) {
    RUNNING.delete(key);
    return null;
  }
  return { since: new Date(r.since).toISOString(), text: r.text };
}

/* Registers a turn and returns its token; only that token can end it. */
function startTurn(docId, text = "") {
  const token = {};
  RUNNING.set(String(docId), { token, since: Date.now(), text: String(text).slice(0, 200) });
  return token;
}

function endTurn(docId, token) {
  const key = String(docId);
  const r = RUNNING.get(key);
  if (r && r.token === token) RUNNING.delete(key);
}

module.exports = { runningTurn, startTurn, endTurn };
