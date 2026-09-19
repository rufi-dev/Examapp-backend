#!/bin/sh
#
# Rehearse the restore, using the LOCAL nightly dump — the same isolated path
# offsite-verify.sh uses after pulling one back from the Storage Box.
#
# It exists so the restore itself is proven and repeatable without touching the
# off-server copy, and so a monthly rehearsal costs one command. Production Mongo
# is never written to: the dump is restored into a throwaway container with its
# own storage, compared against the manifest written when the dump was taken, and
# the container and its volume are removed afterwards.
set -eu

NIGHTLY=/root/backups/mongo/nightly
STAMP=$(date -u +%Y%m%d-%H%M%S)
CNAME=examopia-restore-rehearsal-$STAMP
CVOL=examopia-restore-rehearsal-$STAMP
MONGO_IMAGE=mongo:7.0

cleanup() {
  docker rm -f "$CNAME" >/dev/null 2>&1 || true
  docker volume rm "$CVOL" >/dev/null 2>&1 || true
}
fail() { echo "REHEARSAL FAILED: $*"; cleanup; exit 1; }
trap cleanup EXIT INT TERM

. /root/dump-check.sh
DUMP=$(ls -t "$NIGHTLY"/examopia-*.archive.gz 2>/dev/null | head -1 || true)
REASON=$(check_dump "${DUMP:-}" 48) || fail "$REASON"
MAN="${DUMP%.archive.gz}.manifest.json"
echo "rehearsing with $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1)), taken $(sed -n 's/.*"takenAt":"\([^"]*\)".*/\1/p' "$MAN")"

echo "=== a MongoDB of its own (production is not touched)"
docker volume create "$CVOL" >/dev/null
docker run -d --rm --name "$CNAME" --memory=768m -v "$CVOL":/data/db \
  "$MONGO_IMAGE" --wiredTigerCacheSizeGB=0.25 --bind_ip 127.0.0.1 >/dev/null \
  || fail "could not start the throwaway MongoDB"
i=0
until docker exec "$CNAME" mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 90 ] || fail "the throwaway MongoDB never became ready"
  sleep 1
done
echo "  up after ${i}s"

echo "=== restoring"
docker cp "$DUMP" "$CNAME":/tmp/dump.archive.gz >/dev/null || fail "copying the dump in"
START=$(date +%s)
docker exec "$CNAME" mongorestore --quiet --gzip --archive=/tmp/dump.archive.gz || fail "mongorestore could not read the dump"
echo "  restored in $(( $(date +%s) - START ))s"

echo "=== comparing against the manifest written when the dump was taken"
docker cp "$MAN" "$CNAME":/tmp/manifest.json >/dev/null
RESULT=$(docker exec "$CNAME" mongosh --quiet --eval '
  const fs = require("fs");
  const want = JSON.parse(fs.readFileSync("/tmp/manifest.json", "utf8")).counts || {};
  const d = db.getSiblingDB("examopia");
  const names = new Set(d.getCollectionNames());
  let checked = 0, rows = 0; const bad = [];
  for (const [c, n] of Object.entries(want)) {
    if (!names.has(c)) { if (n > 0) bad.push(c + ": missing (manifest " + n + ")"); continue; }
    const got = d.getCollection(c).countDocuments();
    checked += 1; rows += got;
    if (got !== n) bad.push(c + ": manifest " + n + ", restored " + got);
  }
  print(JSON.stringify({ checked, rows, bad }));
') || fail "could not count the restored collections"

CHECKED=$(echo "$RESULT" | sed -n 's/.*"checked":\([0-9]*\).*/\1/p')
ROWS=$(echo "$RESULT" | sed -n 's/.*"rows":\([0-9]*\).*/\1/p')
BAD=$(echo "$RESULT" | sed -n 's/.*"bad":\[\(.*\)\]}/\1/p')
echo "  $CHECKED collections, $ROWS rows"
[ "${CHECKED:-0}" -gt 0 ] || fail "nothing was restored"
[ -z "$BAD" ] || fail "restored data does not match the manifest → $BAD"

# Not just counts: read one real row back, so "restored" means readable data.
SAMPLE=$(docker exec "$CNAME" mongosh --quiet --eval '
  const d = db.getSiblingDB("examopia");
  const u = d.users.findOne({}, { name: 1, role: 1 });
  print(u ? "a user row reads back: role=" + (u.role || "?") + ", name length=" + String(u.name || "").length : "NO ROWS");
') || fail "could not read a row back"
echo "  $SAMPLE"
case "$SAMPLE" in *"NO ROWS"*) fail "the restore has no readable rows";; esac

echo "=== REHEARSAL PASSED — the dump restores, in isolation, with the rows its manifest promised."
