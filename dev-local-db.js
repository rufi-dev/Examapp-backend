// ── Local dev launcher ─────────────────────────────────────────────
// Spins up a throwaway in-memory MongoDB, injects its connection string
// as MONGO_URI, then boots the real server (server.js) unchanged.
//
//   Usage:  npm run dev:localdb
//
// This is ONLY for quickly running the backend locally with an EMPTY
// database (no real data). For your real data, leave this alone and use
// `npm start` after setting MONGO_URI in .env to your Atlas URI.
//
// Note: server.js calls dotenv.config() at the top, but dotenv does NOT
// override variables already present in process.env — so the MONGO_URI we
// set here wins over the one in .env.
// ───────────────────────────────────────────────────────────────────
const { MongoMemoryServer } = require("mongodb-memory-server");

(async () => {
  try {
    const mongod = await MongoMemoryServer.create({
      instance: { dbName: "examapp" },
    });
    const uri = mongod.getUri();
    process.env.MONGO_URI = uri;
    console.log("[dev-local-db] In-memory MongoDB started:", uri);

    const shutdown = async (signal) => {
      console.log(`\n[dev-local-db] ${signal} received — stopping in-memory MongoDB...`);
      try { await mongod.stop(); } catch (_) {}
      process.exit(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Boot the real server with MONGO_URI already set.
    require("./server.js");
  } catch (err) {
    console.error("[dev-local-db] Failed to start in-memory MongoDB:", err);
    process.exit(1);
  }
})();
