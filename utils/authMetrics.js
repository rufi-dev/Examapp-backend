// AUD-002 metrics (Gate 2). In-process, dependency-free counters + on-demand
// gauges, exposed via snapshot() for a scrape endpoint. LABEL SAFETY: only
// bounded, non-identifying labels (outcome names) are used — NEVER tokens,
// secrets, email, IP, or user IDs (Gate 2 requirement).

const counters = {
  auth_no_exp_token_total: 0,
  auth_refresh_theft_total: 0, // confirmed refresh reuse
  // AUD-008 (CR-051): identity-abuse counters. LABEL-SAFE — only these bounded
  // outcome names, never a raw email/IP/account id.
  auth_ip_throttle_total: 0,
  auth_account_throttle_total: 0,
  auth_email_throttle_total: 0,
  auth_reset_replay_total: 0,
  auth_email_send_fail_total: 0,
  csp_report_total: 0, // AUD-019 CR-055: frontend CSP violation reports received
};
const cspReportSeen = () => { counters.csp_report_total += 1; };
// AUD-008 event incrementers (no arguments carry identifying data).
const THROTTLE_KINDS = { ip: "auth_ip_throttle_total", account: "auth_account_throttle_total", email: "auth_email_throttle_total" };
const throttleBlocked = (kind) => { const k = THROTTLE_KINDS[kind]; if (k) counters[k] += 1; };
const resetReplaySeen = () => { counters.auth_reset_replay_total += 1; };
const emailSendFailed = () => { counters.auth_email_send_fail_total += 1; };
// refresh outcomes by BOUNDED label (the §2.2 precedence outcomes)
const REFRESH_OUTCOMES = ["rotated", "grace_409", "revoked_401", "superseded_401", "expired_401", "unknown_401", "malformed_401", "user_401", "theft_403", "infra_5xx"];
const refreshOutcomeTotal = Object.fromEntries(REFRESH_OUTCOMES.map((o) => [o, 0]));

let workerHeartbeatAt = null; // Date of the last successful worker drain

const noExpTokenSeen = () => { counters.auth_no_exp_token_total += 1; };
const refreshOutcome = (outcome) => { if (outcome in refreshOutcomeTotal) refreshOutcomeTotal[outcome] += 1; };
const theftConfirmed = () => { counters.auth_refresh_theft_total += 1; };
const workerHeartbeat = () => { workerHeartbeatAt = new Date(); };

// Live gauges are read on demand (bounded queries). Returns 0s if the models are
// unavailable. Never throws into a scrape.
async function gauges() {
  try {
    const Session = require("../models/sessionModel");
    const Pending = require("../models/pendingSecurityActionModel");
    const [activeSessions, outboxDepth, deadLetters, fenceDepth] = await Promise.all([
      Session.countDocuments({ revokedAt: null }),
      Pending.countDocuments({ deadLetter: false }),
      Pending.countDocuments({ deadLetter: true }),
      Session.countDocuments({ theftFenceTarget: { $ne: null } }),
    ]);
    return { activeSessions, outboxDepth, deadLetters, fenceDepth };
  } catch (_) {
    return { activeSessions: 0, outboxDepth: 0, deadLetters: 0, fenceDepth: 0 };
  }
}

async function snapshot() {
  return {
    counters: { ...counters },
    refreshOutcomeTotal: { ...refreshOutcomeTotal },
    workerHeartbeatAt,
    workerHeartbeatAgeMs: workerHeartbeatAt ? Date.now() - workerHeartbeatAt.getTime() : null,
    gauges: await gauges(),
  };
}

// Test hook.
const _reset = () => {
  for (const k of Object.keys(counters)) counters[k] = 0;
  REFRESH_OUTCOMES.forEach((o) => (refreshOutcomeTotal[o] = 0));
  workerHeartbeatAt = null;
};

module.exports = { noExpTokenSeen, refreshOutcome, theftConfirmed, workerHeartbeat, throttleBlocked, resetReplaySeen, emailSendFailed, cspReportSeen, snapshot, _reset, REFRESH_OUTCOMES };
