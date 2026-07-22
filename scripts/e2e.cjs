// Test data for the end-to-end suite.
//
// Lives in the backend because it needs Mongo and the app's own .env; the
// frontend test run shells out to it. Everything it creates is prefixed
// __e2e so a cleanup can never touch a real account, and cleanup runs by that
// prefix rather than by remembering ids — an aborted run still gets swept up
// on the next one.
//
//   node scripts/e2e.cjs seed     -> prints { email, password } as JSON
//   node scripts/e2e.cjs cleanup  -> removes every __e2e account and its data
require("dotenv").config();
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const PREFIX = "__e2e";
const PASSWORD = "e2e-test-password";

async function seed(db) {
  const stamp = Date.now();
  const email = `${PREFIX}.${stamp}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const { insertedId } = await db.collection("users").insertOne({
    name: `${PREFIX} teacher`,
    email,
    password: hash,
    role: "teacher",
    phone: "+994500000000",
    isVerified: true,
    onboarded: true,
    userAgent: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log(JSON.stringify({ email, password: PASSWORD, userId: String(insertedId) }));
}

async function cleanup(db) {
  const users = await db
    .collection("users")
    .find({ email: { $regex: `^${PREFIX}\\.` } })
    .project({ _id: 1 })
    .toArray();
  const ids = users.map((u) => u._id);
  if (!ids.length) return console.log(JSON.stringify({ removed: 0 }));

  const classes = await db
    .collection("classes")
    .find({ owner: { $in: ids } })
    .project({ _id: 1 })
    .toArray();
  const classIds = classes.map((c) => c._id);
  const exams = await db
    .collection("exams")
    .find({ owner: { $in: ids } })
    .project({ _id: 1, questions: 1 })
    .toArray();

  await db.collection("questions").deleteMany({
    _id: { $in: exams.map((e) => e.questions).filter(Boolean) },
  });
  await db.collection("exams").deleteMany({ owner: { $in: ids } });
  await db.collection("enrollments").deleteMany({
    $or: [{ student: { $in: ids } }, { class: { $in: classIds } }],
  });
  await db.collection("classes").deleteMany({ _id: { $in: classIds } });
  await db.collection("aiusages").deleteMany({ user: { $in: ids } });
  await db.collection("users").deleteMany({ _id: { $in: ids } });
  console.log(
    JSON.stringify({ removed: ids.length, classes: classIds.length, exams: exams.length })
  );
}

(async () => {
  const cmd = process.argv[2];
  if (!["seed", "cleanup"].includes(cmd)) {
    console.error("usage: node scripts/e2e.cjs seed|cleanup");
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGO_URI);
  try {
    await (cmd === "seed" ? seed : cleanup)(mongoose.connection.db);
  } finally {
    await mongoose.disconnect();
  }
})();
