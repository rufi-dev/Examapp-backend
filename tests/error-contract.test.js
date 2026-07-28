const errorHandler = require("../middleware/errorMiddleware");
const { httpError } = require("../utils/appError");

let passed = 0, failed = 0;
const ok = (name, condition) => {
  if (condition) { passed++; console.log("  ✓", name); }
  else { failed++; console.log("  ✗ FAIL:", name); }
};
function render(error, presetStatus = 200) {
  const out = { statusCode: presetStatus, headers: {} };
  const req = {
    method: "GET",
    originalUrl: "/test",
    requestId: "request-1",
    get: () => null,
  };
  const res = {
    statusCode: presetStatus,
    status(code) { out.statusCode = code; this.statusCode = code; return this; },
    setHeader(key, value) { out.headers[key] = value; },
    json(body) { out.body = body; return this; },
  };
  errorHandler(error, req, res, () => {});
  return out;
}

for (const status of [400, 401, 403, 404, 409, 410, 413, 429]) {
  const out = render(httpError(status, `case_${status}`, "safe", { field: "x" }));
  ok(`typed ${status} status preserved`, out.statusCode === status);
  ok(`typed ${status} envelope stable`,
    out.body.code === `case_${status}` &&
    out.body.message === "safe" &&
    out.body.requestId === "request-1" &&
    out.body.details.field === "x");
}
const canary = "mongodb://secret-host/internal/path.js";
const unknown = render(new Error(canary));
ok("unknown error becomes 500", unknown.statusCode === 500);
ok("unknown error message is redacted", unknown.body.message === "Internal server error");
ok("unknown error does not leak canary", !JSON.stringify(unknown).includes(canary));
ok("request id is returned in body and header",
  unknown.body.requestId === "request-1" && unknown.headers["X-Request-Id"] === "request-1");
const huge = render(httpError(400, "bad", "safe", { value: "x".repeat(3000) }));
ok("oversized details are omitted", huge.body.details === undefined);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
