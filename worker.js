require("dotenv").config();
const mongoose = require("mongoose");
const { assertEnv } = require("./config/validateEnv");
const { assertConfig } = require("./config/validateConfig");
const { assertOrigins } = require("./config/corsOptions");
const { startBackgroundJobs } = require("./jobs/backgroundJobs");
const { maybeStartWorker } = require("./jobs/workerLifecycle");
const { startWorker: startOutboxWorker } = require("./jobs/outboxWorker");
const { flags } = require("./config/featureFlags");
const { preflight } = require("./helper/examPdfStorage");

assertEnv();
assertConfig();
assertOrigins();

let stopJobs = null;
let stopOutbox = null;
let shutdownPromise = null;

async function verifyWorkerInvariants() {
  if (process.env.NODE_ENV !== "production") return;
  await require("./helper/attemptResultIndexes").assertAttemptResultIndexes(mongoose.connection.db);
  await require("./helper/reliabilityIndexes").assertReliabilityIndexes(mongoose.connection.db);
  await require("./helper/tokenIndexes").assertTokenIndexes(mongoose.connection.db);
  await require("./helper/emailIndex").assertEmailUniqueIndex(mongoose.connection.db);
}

function shutdown(reason, code = 0) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`[BACKGROUND] shutting down (${reason})`);
    try {
      if (stopJobs) stopJobs();
      stopJobs = null;
      if (stopOutbox) stopOutbox();
      stopOutbox = null;
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
      console.log("[BACKGROUND] shutdown complete");
      process.exit(code);
    } catch (error) {
      console.error("[BACKGROUND] shutdown failed:", error?.message || error);
      process.exit(code || 1);
    }
  })();
  return shutdownPromise;
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

mongoose.connect(process.env.MONGO_URI)
  .then(async () => {
    await verifyWorkerInvariants();
    await preflight();
    stopJobs = startBackgroundJobs();
    stopOutbox = maybeStartWorker({
      flags,
      startWorker: startOutboxWorker,
      onLog: console.log,
    });
    console.log("[BACKGROUND] started");
  })
  .catch((error) => {
    console.error("[BACKGROUND] startup failed:", error?.message || error);
    shutdown("startup-failed", 1);
  });

module.exports = { shutdown, verifyWorkerInvariants };
