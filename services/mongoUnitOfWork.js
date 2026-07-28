const mongoose = require("mongoose");
const { httpError } = require("../utils/appError");

async function supportsTransactions(connection = mongoose.connection) {
  const hello = await connection.db.admin().command({ hello: 1 });
  return Boolean(hello.setName || hello.msg === "isdbgrid");
}

async function withMongoTransaction(work, { connection = mongoose.connection } = {}) {
  if (!(await supportsTransactions(connection))) {
    // Existing unit tests deliberately use a single-node memory server. The
    // transaction behavior itself is covered with MongoMemoryReplSet; production
    // fails closed instead of silently returning to partial writes.
    if (process.env.NODE_ENV === "test") return work(null);
    throw httpError(
      503,
      "transactions_required",
      "Database transaction support is required for this operation"
    );
  }

  const session = await connection.startSession();
  let result;
  try {
    await session.withTransaction(
      async () => {
        result = await work(session);
      },
      {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      }
    );
    return result;
  } finally {
    await session.endSession();
  }
}

const sessionOpt = (session) => (session ? { session } : {});

module.exports = { withMongoTransaction, supportsTransactions, sessionOpt };
