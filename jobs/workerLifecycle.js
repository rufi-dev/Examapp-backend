// AUD-002 (CR-021): the session-worker startup/shutdown decision, extracted from
// server.js so it is unit-testable via dependency injection. Returns a stop
// function when the worker was started, or null when the feature is off (so no
// timer is created).
function maybeStartWorker({ flags, startWorker, onLog = () => {} } = {}) {
  if (!flags || !flags.SESSION_MODEL_ENABLED) return null; // flag off ⇒ NO timer
  const stop = startWorker({});
  onLog("[AUD-002] outbox worker started (SESSION_MODEL_ENABLED=true)");
  return stop;
}

module.exports = { maybeStartWorker };
