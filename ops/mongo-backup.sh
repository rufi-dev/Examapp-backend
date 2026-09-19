#!/bin/sh
# Nightly dump of the self-hosted examopia database (cron, 02:30 UTC). Keeps 14 days.
# A copy on the same disk protects against mistakes and bad deploys; the off-server
# copy (offsite-backup.sh, 03:15) protects against losing the server.
#
# Each dump is written WITH A MANIFEST: the row count of every collection at the
# moment the dump was taken, plus the archive's checksum and size. That manifest is
# what a restore is checked against — comparing a restore to the LIVE database
# would fail for the ordinary reason that teachers kept working after 02:30.
set -e
cd /root/examopia-backend
. /root/.mongo-admin
DIR=/root/backups/mongo/nightly
mkdir -p "$DIR"
STAMP=$(date -u +%Y%m%d-%H%M)
F="examopia-$STAMP.archive.gz"
M="examopia-$STAMP.manifest.json"
URI="mongodb://admin:$MONGO_ADMIN_PASSWORD@localhost:27017/?authSource=admin&directConnection=true"
log() { echo "$(date -u +%F\ %T) $*" >> "$DIR/backup.log"; }

docker compose exec -T mongo mongodump --uri="$URI" --db=examopia --gzip --archive="/backups/nightly/$F" --quiet
[ -s "$DIR/$F" ] || { log "FAILED: empty dump"; exit 1; }

# The archive must be a READABLE gzip stream, not merely a non-empty file — a dump
# truncated by a full disk or a killed container passes the size check and fails
# only months later, in the restore nobody rehearsed.
gzip -t "$DIR/$F" 2>/dev/null || { log "FAILED: $F is not a readable gzip stream"; rm -f "$DIR/$F"; exit 1; }

# Row counts AT DUMP TIME, from the same instance that was just dumped.
COUNTS=$(docker compose exec -T mongo mongosh --quiet -u admin -p "$MONGO_ADMIN_PASSWORD" \
  --authenticationDatabase admin examopia --eval '
    const out = {};
    db.getCollectionNames().sort().forEach((c) => { out[c] = db.getCollection(c).countDocuments(); });
    print(JSON.stringify(out));
  ' 2>/dev/null) || COUNTS=""
SHA=$(sha256sum "$DIR/$F" | cut -d" " -f1)
BYTES=$(stat -c %s "$DIR/$F")
if [ -n "$COUNTS" ]; then
  printf '{"archive":"%s","takenAt":"%s","bytes":%s,"sha256":"%s","counts":%s}\n' \
    "$F" "$(date -u +%FT%TZ)" "$BYTES" "$SHA" "$COUNTS" > "$DIR/$M"
else
  log "WARNING: could not read collection counts — $F has no manifest"
fi

# Retention: drop the manifest with its archive, never one without the other.
find "$DIR" -name 'examopia-*.archive.gz' -mtime +14 -delete
find "$DIR" -name 'examopia-*.manifest.json' -mtime +14 -delete

log "ok $F $(du -h "$DIR/$F" | cut -f1)$([ -f "$DIR/$M" ] && echo " +manifest" || echo " (no manifest)")"
