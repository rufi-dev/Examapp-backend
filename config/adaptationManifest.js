/*
 * FROZEN manifest of adaptation templates + evaluators.
 *
 * CR-MSO-017: editing a v1 template spec, or the v1 evaluator, WITHOUT bumping the
 * version must not silently re-interpret documents already published against it.
 * assertAdaptationManifest() recomputes these digests at production startup and
 * refuses to boot on any mismatch — including a REMOVED entry, since a pinned
 * template or evaluator that no longer exists is just as unverifiable.
 *
 * Regenerate ONLY when deliberately adding a .v2 (never to "fix" a red boot):
 *   node scripts/freezeAdaptationManifest.cjs
 */
module.exports = {
  "templates": {
    "area_rectangle.v1": "5ba83509add79162ca368e8e144ab6616de638e595394cfe1c8ab9319711e4f8",
    "linear_equation_root.v1": "de60da46fb84a19220acf5e4f829d97490aab360b51729eb7c288bd3f32d3bfe",
    "percent_of.v1": "b2b09d09260309e241881779b9f5b044aa997adbadda1e8c305c68ceb9a27d90",
    "speed_distance_time.v1": "c15b1c5be7fe49a568ddf5cd03effd1f2d2e4c48f2b14a45dd1c21090fbc7877",
    "volume_rectangular_prism.v1": "cade037b9a829568b7bc78fa04127bf2007f6c9e539ba485926c844b68421708"
  },
  "evaluators": {
    "v1": "33f74ac28b93da1936634ea0dafc381b7960683a7e1c8dd26ed00410c32934d8"
  }
};
