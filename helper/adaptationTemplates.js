/*
 * CR-MSO-007 / CR-MSO-013 / CR-MSO-017 — verifiable numeric adaptation.
 *
 * "The server recomputes every transformed answer" is not generally possible: for
 * an arbitrary word problem there is nothing to recompute against. So only tasks
 * with a FORMAL model are auto-verified, and everything else is honestly marked
 * needs_teacher_review rather than claiming a verification that never happened.
 *
 * THE MODEL NEVER SUPPLIES CODE. It picks a `templateId` and supplies named,
 * bounded variables. The arithmetic is a DECLARATIVE spec (an operation tree over
 * those variables) executed by a fixed evaluator. There is no eval, no Function,
 * and no expression interpreter reachable from model output — `expression` on a
 * task is display text only.
 *
 * TWO append-only registries, both pinned into the published document:
 *
 *   templates  `volume_rectangular_prism.v1` — frozen forever; a behaviour change
 *              ships as `.v2` and never touches `.v1`.
 *   evaluators `v1` — an append-only REGISTRY keyed by version, not one
 *              replaceable current evaluator. A template pins an exact
 *              evaluatorVersion and resolution selects THAT implementation; adding
 *              `v2` cannot change how a `v1` document is interpreted, and there is
 *              no fallback to the newest.
 *
 * templateHash = sha256({templateId, spec, evaluatorVersion}), so editing a spec or
 * an evaluator in place without bumping the version FAILS CLOSED — at boot via the
 * manifest assertion, and at verification/export/grading via template_hash_mismatch.
 */
const crypto = require("crypto");
const { stableStringify } = require("./immutableVersion");

// ------------------------------------------------------------ evaluators
/*
 * An evaluator turns a declarative op-tree into a number. Append-only: v1 stays
 * exactly as it is forever. Its source digest is part of the manifest, so editing
 * it in place refuses to boot.
 */
const EVALUATORS = {
  v1: {
    version: "v1",
    // Deliberately tiny and total: every op is finite-checked, division guards
    // zero, and an unknown op throws rather than returning something plausible.
    evaluate(node, vars) {
      const ev = (child) => this.evaluate(child, vars);
      if (node === null || node === undefined) throw new Error("adaptation_spec_invalid");
      if (typeof node === "number") {
        if (!Number.isFinite(node)) throw new Error("adaptation_non_finite");
        return node;
      }
      if (typeof node === "string") {
        if (!Object.prototype.hasOwnProperty.call(vars, node)) throw new Error("adaptation_unknown_variable");
        const v = Number(vars[node]);
        if (!Number.isFinite(v)) throw new Error("adaptation_non_finite");
        return v;
      }
      if (typeof node !== "object" || Array.isArray(node)) throw new Error("adaptation_spec_invalid");
      const { op, args } = node;
      const a = Array.isArray(args) ? args.map(ev) : [];
      let out;
      switch (op) {
        case "add": out = a.reduce((x, y) => x + y, 0); break;
        case "sub": out = a.slice(1).reduce((x, y) => x - y, a[0]); break;
        case "mul": out = a.reduce((x, y) => x * y, 1); break;
        case "div":
          if (a.length !== 2) throw new Error("adaptation_spec_invalid");
          if (a[1] === 0) throw new Error("adaptation_division_by_zero");
          out = a[0] / a[1];
          break;
        case "pow":
          if (a.length !== 2) throw new Error("adaptation_spec_invalid");
          out = Math.pow(a[0], a[1]);
          break;
        case "sqrt":
          if (a.length !== 1 || a[0] < 0) throw new Error("adaptation_spec_invalid");
          out = Math.sqrt(a[0]);
          break;
        case "neg": out = -a[0]; break;
        default: throw new Error("adaptation_unknown_op");
      }
      if (!Number.isFinite(out)) throw new Error("adaptation_non_finite");
      return out;
    },
  },
};

// A pinned evaluator must resolve EXACTLY. No fallback to the newest, ever —
// falling back is precisely how an old document silently gets new semantics.
function evaluatorFor(version) {
  const ev = EVALUATORS[String(version || "")];
  if (!ev) {
    const e = new Error("evaluator_version_unknown");
    e.code = "evaluator_version_unknown";
    e.version = version;
    throw e;
  }
  return ev;
}

const evaluatorDigest = (version) =>
  crypto.createHash("sha256").update(String(evaluatorFor(version).evaluate.toString())).digest("hex");

// ------------------------------------------------------------ templates
const round = (v, rule) => {
  if (rule === "int") return Math.round(v);
  const m = /^(\d)dp$/.exec(String(rule || ""));
  if (m) { const f = 10 ** Number(m[1]); return Math.round(v * f) / f; }
  return v;
};

const TEMPLATES = {
  "volume_rectangular_prism.v1": {
    evaluatorVersion: "v1",
    label: "Düzbucaqlı paralelepipedin həcmi",
    variables: [
      { name: "a", min: 0.1, max: 1000, unit: "sm" },
      { name: "b", min: 0.1, max: 1000, unit: "sm" },
      { name: "c", min: 0.1, max: 1000, unit: "sm" },
    ],
    resultUnit: "sm³",
    spec: { op: "mul", args: ["a", "b", "c"] },
  },
  "area_rectangle.v1": {
    evaluatorVersion: "v1",
    label: "Düzbucaqlının sahəsi",
    variables: [
      { name: "a", min: 0.1, max: 1000, unit: "sm" },
      { name: "b", min: 0.1, max: 1000, unit: "sm" },
    ],
    resultUnit: "sm²",
    spec: { op: "mul", args: ["a", "b"] },
  },
  "linear_equation_root.v1": {
    evaluatorVersion: "v1",
    label: "ax + b = c tənliyinin kökü",
    variables: [
      { name: "a", min: -1000, max: 1000, unit: "" },
      { name: "b", min: -10000, max: 10000, unit: "" },
      { name: "c", min: -10000, max: 10000, unit: "" },
    ],
    resultUnit: "",
    spec: { op: "div", args: [{ op: "sub", args: ["c", "b"] }, "a"] },
  },
  "percent_of.v1": {
    evaluatorVersion: "v1",
    label: "Ədədin faizi",
    variables: [
      { name: "whole", min: 0, max: 1e9, unit: "" },
      { name: "percent", min: 0, max: 100, unit: "%" },
    ],
    resultUnit: "",
    spec: { op: "div", args: [{ op: "mul", args: ["whole", "percent"] }, 100] },
  },
  "speed_distance_time.v1": {
    evaluatorVersion: "v1",
    label: "Sürət = məsafə / zaman",
    variables: [
      { name: "distance", min: 0, max: 1e6, unit: "km" },
      { name: "time", min: 0.01, max: 1000, unit: "saat" },
    ],
    resultUnit: "km/saat",
    spec: { op: "div", args: ["distance", "time"] },
  },
};

const templateHashOf = (templateId) => {
  const t = TEMPLATES[templateId];
  if (!t) return null;
  return crypto
    .createHash("sha256")
    .update(stableStringify({ templateId, spec: t.spec, evaluatorVersion: t.evaluatorVersion }))
    .digest("hex");
};

/*
 * The frozen manifest. A production startup assertion recomputes this and compares
 * — so editing a v1 spec, or the v1 evaluator, without bumping the version refuses
 * to boot rather than silently re-interpreting existing documents.
 */
function buildManifest() {
  const templates = Object.fromEntries(Object.keys(TEMPLATES).sort().map((id) => [id, templateHashOf(id)]));
  const evaluators = Object.fromEntries(Object.keys(EVALUATORS).sort().map((v) => [v, evaluatorDigest(v)]));
  return { templates, evaluators };
}

/*
 * Verify + compute ONE adaptation.
 * Returns { ok, code, value, unit }. Never throws for model-shaped input — an
 * unknown template, an out-of-bounds variable or a mismatch is a typed refusal the
 * validator turns into needs_teacher_review.
 */
function computeAdaptation(adaptation) {
  const a = adaptation && typeof adaptation === "object" ? adaptation : {};
  const t = TEMPLATES[a.templateId];
  if (!t) return { ok: false, code: "template_unknown" };

  // The pinned hash must match what this build actually computes with. A document
  // is interpreted under its ORIGINAL semantics or not at all.
  const expected = templateHashOf(a.templateId);
  if (a.templateHash && a.templateHash !== expected) return { ok: false, code: "template_hash_mismatch" };
  if (a.evaluatorVersion && a.evaluatorVersion !== t.evaluatorVersion) {
    return { ok: false, code: "evaluator_version_mismatch" };
  }

  const supplied = Array.isArray(a.variables) ? a.variables : [];
  const vars = {};
  for (const decl of t.variables) {
    const hit = supplied.find((v) => v && v.name === decl.name);
    if (!hit) return { ok: false, code: "variable_missing", variable: decl.name };
    const val = Number(hit.value);
    if (!Number.isFinite(val)) return { ok: false, code: "variable_non_finite", variable: decl.name };
    if (val < decl.min || val > decl.max) return { ok: false, code: "variable_out_of_bounds", variable: decl.name };
    if (decl.unit && hit.unit && String(hit.unit) !== decl.unit) {
      return { ok: false, code: "unit_mismatch", variable: decl.name };
    }
    vars[decl.name] = val;
  }

  let raw;
  try {
    raw = evaluatorFor(t.evaluatorVersion).evaluate(t.spec, vars);
  } catch (e) {
    return { ok: false, code: e.code || e.message || "adaptation_failed" };
  }
  const value = round(raw, a.rounding);
  if (!Number.isFinite(value)) return { ok: false, code: "adaptation_non_finite" };
  return { ok: true, code: null, value, unit: t.resultUnit };
}

// Does the task's CLAIMED answer match what the server computes?
function verifyAdaptation(adaptation, tolerance = 1e-6) {
  const r = computeAdaptation(adaptation);
  if (!r.ok) return r;
  const claimed = Number(adaptation.computed);
  if (!Number.isFinite(claimed)) return { ok: false, code: "computed_missing", value: r.value, unit: r.unit };
  if (Math.abs(claimed - r.value) > tolerance) {
    return { ok: false, code: "computed_mismatch", value: r.value, claimed, unit: r.unit };
  }
  return { ok: true, code: null, value: r.value, unit: r.unit };
}

module.exports = {
  TEMPLATES,
  EVALUATORS,
  evaluatorFor,
  evaluatorDigest,
  templateHashOf,
  buildManifest,
  computeAdaptation,
  verifyAdaptation,
  round,
};
