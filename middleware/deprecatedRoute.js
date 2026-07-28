const counters = new Map();

function deprecatedRoute(name, { removalAfter }) {
  if (!name || !removalAfter) throw new Error("deprecated route requires name and removalAfter");
  return function retiredRoute(req, res) {
    counters.set(name, (counters.get(name) || 0) + 1);
    res.status(410).json({
      code: "route_retired",
      message: "This endpoint has been retired",
      replacement: "Use the exam builder save endpoint",
      removalAfter,
    });
  };
}

function deprecatedRouteMetrics() {
  return Object.fromEntries(counters);
}

module.exports = { deprecatedRoute, deprecatedRouteMetrics };
