#!/bin/sh
#
# Nightly OFF-SERVER backup → Hetzner Storage Box, via BorgBackup.
#
# Everything on this box is one hardware failure away from being gone: the
# database, every teacher's videos and materials, and every student's uploaded
# work. The nightly mongodump already runs (mongo-backup.sh, 02:30) but it lands
# on the SAME disk. This carries the dumps and the file volumes off the machine.
#
# Borg, rather than plain rsync, for three reasons that matter here:
#   - the archive is ENCRYPTED (student work and teacher content leave the box),
#   - only changed chunks upload, so a night costs a fraction of the whole set,
#   - it keeps history, so a file deleted or corrupted weeks ago is still there.
#
# WhatsApp session data is deliberately NOT included: re-scanning the QR code
# recreates it, and it is a live login credential.
#
# Every outcome lands in the log as `ok`, `FAILED` or `SKIPPED`, and the admin
# Health page reads that log — so a night that did not happen is visible in the
# product, not only to whoever opens a terminal.
#
# Restore: see /root/OFFSITE-RESTORE.md
set -eu

CONF=/root/.offsite.conf
PASSFILE=/root/.borg-pass
KEY=/root/.ssh/storagebox_ed25519
NIGHTLY=/root/backups/mongo/nightly
LOG=/root/backups/mongo/offsite.log   # inside the folder the backend mounts read-only
VOLUMES=/var/lib/docker/volumes
STALE_HOURS=36          # a successful run older than this is an alert
MAX_DUMP_AGE_HOURS=8    # a dump older than this is not tonight's

say() { echo "$(date -u '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
# The checks that decide whether a dump may be called a backup. Kept in their own
# file so they can be exercised against crafted files (dump-check.test.sh) — they
# only ever matter on a night when something has already gone wrong.
. /root/dump-check.sh
last_ok_age_hours() {
  L=$(grep ' ok ' "$LOG" 2>/dev/null | tail -1 | cut -d' ' -f1,2) || true
  [ -n "${L:-}" ] || { echo 99999; return; }
  NOW=$(date -u +%s); THEN=$(date -u -d "$L" +%s 2>/dev/null || echo 0)
  [ "$THEN" -gt 0 ] && echo $(( (NOW - THEN) / 3600 )) || echo 99999
}

[ -f "$CONF" ] || { say "FAILED: no $CONF"; exit 1; }
# shellcheck disable=SC1090
. "$CONF"
if [ -z "${STORAGEBOX_HOST:-}" ] || [ -z "${STORAGEBOX_USER:-}" ]; then
  # Before configuration this is expected. AFTER it, a skipped night is a real
  # alert — the Health page turns a stale/failed log line into a warning.
  say "SKIPPED: Storage Box not configured yet (STORAGEBOX_HOST/USER empty)"
  exit 0
fi
[ -f "$PASSFILE" ] || { say "FAILED: no repository passphrase"; exit 1; }

AGE=$(last_ok_age_hours)
[ "$AGE" -lt "$STALE_HOURS" ] || say "WARNING: no successful off-server backup in ${AGE}h — this run is overdue"

export BORG_PASSPHRASE="$(cat "$PASSFILE")"
export BORG_RSH="ssh -i $KEY -p 23 -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
REPO="ssh://$STORAGEBOX_USER@$STORAGEBOX_HOST:23/./examopia-borg"
STAMP=$(date -u +%Y%m%d-%H%M)

say "start $STAMP"

# A fresh dump first, so the newest data is in tonight's archive even if this runs
# before the 02:30 job (that script keeps its own retention and manifest).
if [ -x /root/mongo-backup.sh ]; then
  /root/mongo-backup.sh >/dev/null 2>&1 || say "WARNING: fresh mongodump failed — checking the previous one"
fi

# ---- the dump must be TONIGHT'S, WHOLE and CHECKSUM-MATCHED ------------------
# Uploading a stale or truncated dump is worse than uploading none: it looks like
# a backup and restores like a wound.
DUMP=$(ls -t "$NIGHTLY"/examopia-*.archive.gz 2>/dev/null | head -1 || true)
DUMP_OK=0
if REASON=$(check_dump "${DUMP:-}" "$MAX_DUMP_AGE_HOURS"); then
  DUMP_OK=1
else
  say "FAILED: $REASON"
fi

# The files are still worth carrying off the server even when the dump is bad, but
# the run is NEVER reported as ok — the log says degraded and the Health page warns.
if [ "$DUMP_OK" = "0" ]; then
  say "DEGRADED: continuing with FILES ONLY — the database dump did not pass its checks"
fi

# The operational scripts go too: a restore onto a fresh machine needs the backup
# and restore tooling itself, and losing the server would otherwise lose it.
SETS="/root/examopia-backend/.env /root/examopia-backend/docker-compose.yml /root/examopia-backend/Caddyfile /root/examopia-backend/mongo-keyfile"
for f in mongo-backup.sh offsite-backup.sh offsite-verify.sh dump-check.sh restore-rehearsal.sh docker-cleanup.sh OFFSITE-RESTORE.md; do
  [ -f "/root/$f" ] && SETS="$SETS /root/$f"
done
[ "$DUMP_OK" = "1" ] && SETS="$NIGHTLY $SETS"
for v in videos assignments materials curriculum guidevideos exampdfs boardfiles uploads; do
  d="$VOLUMES/examopia-backend_$v/_data"
  [ -d "$d" ] && SETS="$SETS $d"
done

# First run initialises the repository (encrypted with the local passphrase).
if ! borg list "$REPO" >/dev/null 2>&1; then
  say "initialising repository"
  borg init --encryption=repokey-blake2 "$REPO" >> "$LOG" 2>&1 || { say "FAILED: init"; exit 1; }
  # The key also lives inside the repo; a copy here means a restore needs only the
  # passphrase. Keep BOTH off the server too — see OFFSITE-RESTORE.md.
  borg key export "$REPO" /root/.borg-repokey >> "$LOG" 2>&1 || true
  chmod 600 /root/.borg-repokey 2>/dev/null || true
fi

# shellcheck disable=SC2086
if borg create --stats --compression zstd,3 \
     --exclude '*/.wwebjs_auth/*' --exclude '*/node_modules/*' --exclude '*.tmp' \
     "$REPO::examopia-$STAMP" $SETS >> "$LOG" 2>&1; then
  say "archive examopia-$STAMP created"
else
  say "FAILED: borg create"
  exit 1
fi

# History without unbounded growth.
borg prune --list --keep-daily=7 --keep-weekly=4 --keep-monthly=6 --glob-archives 'examopia-*' "$REPO" >> "$LOG" 2>&1 \
  || say "WARNING: prune failed"
borg compact "$REPO" >> "$LOG" 2>&1 || true

# Prove the archive is readable, not just that the upload returned 0.
if borg list "$REPO::examopia-$STAMP" >/dev/null 2>&1; then
  # What this run ACTUALLY uploaded, measured — never an estimate. The archive's
  # deduplicated size is the new data that had to travel; the repository total is
  # what the Storage Box holds in all.
  UPLOADED=$(borg info "$REPO::examopia-$STAMP" 2>/dev/null | awk '/Deduplicated size/ {print $3" "$4}')
  TOTAL=$(borg info "$REPO" 2>/dev/null | awk '/All archives/ {print $4" "$5}')
  if [ "$DUMP_OK" = "1" ]; then
    say "ok examopia-$STAMP verified, measured upload ${UPLOADED:-?}, repository ${TOTAL:-?}"
  else
    say "FAILED: files archived (upload ${UPLOADED:-?}) but WITHOUT a valid database dump"
    exit 1
  fi
else
  say "FAILED: archive not readable after upload"
  exit 1
fi

# A weekly consistency check of the repository itself, so rot is found by us and
# not by a restore during an emergency. Sundays, after the archive is in.
if [ "$(date -u +%u)" = "7" ]; then
  if borg check --last 3 "$REPO" >> "$LOG" 2>&1; then say "weekly borg check ok"; else say "WARNING: weekly borg check FAILED"; fi
fi
