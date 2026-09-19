#!/bin/sh
#
# Prove the off-server backup is real: check the repository, show what retention
# would keep, and RESTORE — a database dump and an uploaded file — then compare
# them against what was true when the dump was taken.
#
# A backup nobody has restored is a backup nobody knows they have.
#
# Two rules this obeys, because a verification that damages what it verifies is
# not a verification:
#   1. the dump is restored into a THROWAWAY MongoDB container of its own, with
#      its own storage — production Mongo is never written to, not even a scratch
#      database inside it;
#   2. restored row counts are compared against the MANIFEST written when the dump
#      was taken, never against the live database, which legitimately moves on
#      between 02:30 and now.
set -eu

CONF=/root/.offsite.conf
PASSFILE=/root/.borg-pass
KEY=/root/.ssh/storagebox_ed25519
STAMP=$(date -u +%Y%m%d-%H%M%S)
WORK=/tmp/offsite-verify-$STAMP
CNAME=examopia-restore-test-$STAMP
CVOL=examopia-restore-test-$STAMP
MONGO_IMAGE=mongo:7.0

cleanup() {
  docker rm -f "$CNAME" >/dev/null 2>&1 || true
  docker volume rm "$CVOL" >/dev/null 2>&1 || true
  rm -rf "$WORK" 2>/dev/null || true
}
fail() { echo "VERIFY FAILED: $*"; cleanup; exit 1; }
trap cleanup EXIT INT TERM

[ -f "$CONF" ] || fail "no $CONF"
# shellcheck disable=SC1090
. "$CONF"
[ -n "${STORAGEBOX_HOST:-}" ] || fail "Storage Box not configured yet"

export BORG_PASSPHRASE="$(cat "$PASSFILE")"
export BORG_RSH="ssh -i $KEY -p 23 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
REPO="ssh://$STORAGEBOX_USER@$STORAGEBOX_HOST:23/./examopia-borg"

echo "=== 1. the repository and every archive in it verify"
borg check --verify-data "$REPO" || fail "borg check"
echo "  ok — data read back and checksummed, not merely listed"

echo "=== 2. archives, and what retention would keep"
borg list --format '{archive}{TAB}{time}{NL}' "$REPO" | sed 's/^/  /'
echo "  --- prune plan (DRY RUN, nothing is deleted):"
borg prune --dry-run --list --keep-daily=7 --keep-weekly=4 --keep-monthly=6 \
  --glob-archives 'examopia-*' "$REPO" 2>&1 | sed 's/^/    /'

LATEST=$(borg list --last 1 --format '{archive}' "$REPO")
[ -n "$LATEST" ] || fail "no archives in the repository"
echo "=== 3. restoring from $LATEST (nothing here touches production)"
mkdir -p "$WORK"

# ---- the database dump, and the manifest written beside it at dump time
DUMP_PATH=$(borg list --format '{path}{NL}' "$REPO::$LATEST" | grep 'backups/mongo/nightly/.*\.archive\.gz$' | tail -1)
[ -n "$DUMP_PATH" ] || fail "no database dump inside the archive"
MAN_PATH="${DUMP_PATH%.archive.gz}.manifest.json"
( cd "$WORK" && borg extract "$REPO::$LATEST" "$DUMP_PATH" ) || fail "extracting the dump"
( cd "$WORK" && borg extract "$REPO::$LATEST" "$MAN_PATH" ) || fail "extracting the manifest"
DUMP_FILE="$WORK/$DUMP_PATH"
MAN_FILE="$WORK/$MAN_PATH"
[ -s "$DUMP_FILE" ] || fail "the extracted dump is empty"
echo "  dump extracted: $(du -h "$DUMP_FILE" | cut -f1), taken $(sed -n 's/.*"takenAt":"\([^"]*\)".*/\1/p' "$MAN_FILE")"

# The archive must match the checksum recorded when it was written — proof the
# bytes that came back are the bytes that went up.
WANT=$(sed -n 's/.*"sha256":"\([a-f0-9]*\)".*/\1/p' "$MAN_FILE")
GOT=$(sha256sum "$DUMP_FILE" | cut -d' ' -f1)
[ "$WANT" = "$GOT" ] || fail "the restored dump does not match its manifest checksum"
echo "  checksum matches the manifest"

echo "=== 4. restoring it into a THROWAWAY MongoDB container"
docker volume create "$CVOL" >/dev/null
docker run -d --rm --name "$CNAME" --memory=768m -v "$CVOL":/data/db \
  "$MONGO_IMAGE" --wiredTigerCacheSizeGB=0.25 --bind_ip 127.0.0.1 >/dev/null \
  || fail "could not start the throwaway MongoDB"
# Wait for it, rather than sleeping a guessed number of seconds.
i=0
until docker exec "$CNAME" mongosh --quiet --eval 'db.adminCommand({ ping: 1 }).ok' >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 60 ] || fail "the throwaway MongoDB never became ready"
  sleep 1
done
docker cp "$DUMP_FILE" "$CNAME":/tmp/dump.archive.gz >/dev/null || fail "copying the dump into the container"
docker exec "$CNAME" mongorestore --quiet --gzip --archive=/tmp/dump.archive.gz \
  || fail "mongorestore could not read the backed-up dump"

# ---- compare against the manifest, collection by collection
docker cp "$MAN_FILE" "$CNAME":/tmp/manifest.json >/dev/null
RESULT=$(docker exec "$CNAME" mongosh --quiet --eval '
  const fs = require("fs");
  const want = JSON.parse(fs.readFileSync("/tmp/manifest.json", "utf8")).counts || {};
  const db2 = db.getSiblingDB("examopia");
  const names = new Set(db2.getCollectionNames());
  let checked = 0, rows = 0; const bad = [];
  for (const [c, n] of Object.entries(want)) {
    if (!names.has(c)) { if (n > 0) bad.push(c + ": missing (manifest " + n + ")"); continue; }
    const got = db2.getCollection(c).countDocuments();
    checked += 1; rows += got;
    if (got !== n) bad.push(c + ": manifest " + n + ", restored " + got);
  }
  print(JSON.stringify({ checked, rows, bad }));
') || fail "could not count the restored collections"

CHECKED=$(echo "$RESULT" | sed -n 's/.*"checked":\([0-9]*\).*/\1/p')
ROWS=$(echo "$RESULT" | sed -n 's/.*"rows":\([0-9]*\).*/\1/p')
BAD=$(echo "$RESULT" | sed -n 's/.*"bad":\[\(.*\)\]}/\1/p')
echo "  restored $CHECKED collections, $ROWS rows, in a container of its own"
[ "${CHECKED:-0}" -gt 0 ] || fail "nothing was restored"
[ -z "$BAD" ] || fail "restored data does not match the manifest → $BAD"
echo "  every collection matches the counts recorded when the dump was taken"

echo "=== 5. an uploaded file comes back byte for byte"
FILE_PATH=$(borg list --format '{path}{TAB}{size}{NL}' "$REPO::$LATEST" \
  | grep -E 'volumes/examopia-backend_(materials|assignments|exampdfs|boardfiles)/_data/' \
  | awk -F'\t' '$2 > 1000 {print $1; exit}')
[ -n "$FILE_PATH" ] || fail "no uploaded file inside the archive"
( cd "$WORK" && borg extract "$REPO::$LATEST" "$FILE_PATH" ) || fail "extracting an uploaded file"
A=$(sha256sum "$WORK/$FILE_PATH" | cut -d' ' -f1)
B=$(sha256sum "/$FILE_PATH" | cut -d' ' -f1)
echo "  $(basename "$FILE_PATH") ($(du -h "$WORK/$FILE_PATH" | cut -f1))"
[ "$A" = "$B" ] || fail "the restored file does not match the live one"
echo "  checksum matches the live file"

echo "=== 6. what this actually costs"
borg info "$REPO" | grep -E 'All archives|Unique chunks' | sed 's/^/  /'

echo "=== VERIFIED: repository checks out; the dump restores in isolation with the"
echo "    rows its manifest promised; an uploaded file returns identical."
