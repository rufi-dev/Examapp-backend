const SPECS = [
  ...["users", "materials", "videos", "exams", "results"].map((collection) => ({
    collection,
    name: "page_createdAt_desc",
    key: { createdAt: -1, _id: -1 },
    options: { name: "page_createdAt_desc" },
  })),
  {
    collection: "exams",
    name: "uniq_exam_creation",
    key: { owner: 1, creationKey: 1 },
    options: {
      name: "uniq_exam_creation",
      unique: true,
      partialFilterExpression: { creationKey: { $type: "string" } },
    },
  },
  {
    collection: "attempts",
    name: "due_attempt_finalizer",
    key: {
      unscorable: 1,
      expiresAt: 1,
      finalizeNextAttemptAt: 1,
      finalizeLeaseUntil: 1,
    },
    options: {
      name: "due_attempt_finalizer",
      partialFilterExpression: { submitted: false },
    },
  },
  {
    collection: "exams",
    name: "due_exam_report",
    key: { endDate: 1, reportNextAttemptAt: 1, reportLeaseUntil: 1 },
    options: {
      name: "due_exam_report",
      partialFilterExpression: { reportSentAt: null },
    },
  },
];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function shapeReason(spec, got) {
  if (!got) return "missing";
  if (!same(got.key, spec.key)) return "key";
  if (!!got.unique !== !!spec.options.unique) return "unique";
  if (
    !same(
      got.partialFilterExpression || null,
      spec.options.partialFilterExpression || null
    )
  ) return "partial";
  if (!!got.sparse !== !!spec.options.sparse) return "sparse";
  if ((got.expireAfterSeconds ?? null) !== (spec.options.expireAfterSeconds ?? null)) {
    return "ttl";
  }
  if (!same(got.collation || null, spec.options.collation || null)) return "collation";
  if (!!got.hidden !== !!spec.options.hidden) return "hidden";
  return null;
}

async function verifyReliabilityIndexes(db) {
  const failures = [];
  for (const spec of SPECS) {
    const exists = await db
      .listCollections({ name: spec.collection }, { nameOnly: true })
      .hasNext();
    if (!exists) {
      failures.push({ ...spec, reason: "collection_missing" });
      continue;
    }
    const indexes = await db.collection(spec.collection).indexes();
    const reason = shapeReason(spec, indexes.find((i) => i.name === spec.name));
    if (reason) failures.push({ collection: spec.collection, name: spec.name, reason });
    for (const index of indexes) {
      if (index.name === "_id_" || index.name === spec.name) continue;
      if (same(index.key, spec.key)) {
        failures.push({
          collection: spec.collection,
          name: index.name,
          reason: "unexpected_same_key_variant",
        });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

async function assertReliabilityIndexes(db) {
  const result = await verifyReliabilityIndexes(db);
  if (!result.ok) {
    throw new Error(
      `Reliability index contract failed: ${result.failures
        .map((f) => `${f.collection}.${f.name}:${f.reason}`)
        .join(", ")}`
    );
  }
}

module.exports = { SPECS, shapeReason, verifyReliabilityIndexes, assertReliabilityIndexes };
