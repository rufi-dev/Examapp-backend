/*
 * "Yazır…" in the chat bubble — only while the AI is actually writing.
 *
 * A teacher who sends a message and sees nothing for several seconds reads it
 * as being ignored. The indicator must still be honest: no fixed animation
 * after every message, no dots that run on after the answer landed. So the
 * flag is set right before a reply is generated and cleared right before it is
 * saved, and the thread poll reports it.
 *
 * In memory, on purpose: it lives seconds, means nothing after a restart, and
 * the chat runs in one backend process. A turn that dies without its finally
 * still ends: anything older than MAX_MS reads as not typing.
 */
const MAX_MS = 120000;
const active = new Map(); // conversationId -> Map(token -> startedAt)

let seq = 0;

function startTyping(conversationId, now = Date.now()) {
  const id = String(conversationId);
  const token = `${now}-${(seq += 1)}`;
  if (!active.has(id)) active.set(id, new Map());
  active.get(id).set(token, now);
  return token;
}

function stopTyping(conversationId, token) {
  const id = String(conversationId);
  const turns = active.get(id);
  if (!turns) return;
  turns.delete(token);
  if (!turns.size) active.delete(id);
}

function isTyping(conversationId, now = Date.now()) {
  const turns = active.get(String(conversationId));
  if (!turns) return false;
  for (const [token, at] of turns) {
    if (now - at < MAX_MS) return true;
    turns.delete(token); // a turn that never ended
  }
  active.delete(String(conversationId));
  return false;
}

module.exports = { startTyping, stopTyping, isTyping, MAX_MS };
