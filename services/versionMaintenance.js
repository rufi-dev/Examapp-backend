// CR-035 — the ONLY authorized way to mutate/delete otherwise-immutable published
// ExamVersion rows. There is no public `{ maintenance: true }` bypass any more: the
// model middleware authorizes a mutation ONLY when it runs inside a
// `performMaintenance` async context, which requires an actor, a reason, explicit
// authorization, and writes a durable audit event FIRST.
const { AsyncLocalStorage } = require("async_hooks");

const als = new AsyncLocalStorage();

// The model middleware calls this; true only inside an authorized performMaintenance
// async context (scoped via AsyncLocalStorage, so it is concurrency-safe).
function isAuthorizedContext() {
  const store = als.getStore();
  return !!(store && store.authorized === true);
}

// Run `fn` as an authorized maintenance operation. Requires a non-empty actor +
// reason and explicit `authorized:true`; records an audit event before running.
async function performMaintenance({ actor, reason, action, target = null, authorized } = {}, fn) {
  if (typeof fn !== "function") throw new Error("performMaintenance: fn is required");
  if (authorized !== true) throw new Error("performMaintenance: explicit authorized:true is required");
  if (!actor || typeof actor !== "string") throw new Error("performMaintenance: a non-empty actor is required");
  if (!reason || typeof reason !== "string") throw new Error("performMaintenance: a non-empty reason is required");

  // Durable audit FIRST, so an authorized mutation always leaves a trail.
  const MaintenanceAudit = require("../models/maintenanceAuditModel");
  await MaintenanceAudit.create({ action: action || "maintenance", actor, reason, target, at: new Date() });

  // AWAIT inside the async context so the store propagates through the Mongoose
  // query's pre-hook execution (returning the un-awaited query would run exec
  // outside this context and re-trigger the immutability block).
  return als.run({ authorized: true, actor, reason }, async () => fn());
}

module.exports = { performMaintenance, isAuthorizedContext };
