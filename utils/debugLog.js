const DebugLog = require("../models/debugLogModel");

// Fire-and-forget diagnostic write. NEVER blocks or breaks the request — any
// failure (DB down, validation) is swallowed.
const recordDebug = (entry) => {
  try {
    DebugLog.create(entry).catch(() => {});
  } catch {
    /* ignore */
  }
};

module.exports = { recordDebug };
