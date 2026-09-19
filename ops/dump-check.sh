#!/bin/sh
# Is this database dump fit to be called a backup?
#
# Sourced by offsite-backup.sh and exercised directly by dump-check.test.sh. Kept
# apart from the backup script so the refusals can be tested against crafted files
# instead of being taken on trust — these checks only ever matter on the night
# something has already gone wrong.
#
# check_dump <archive> <max_age_hours>  → prints a reason and returns 1 if unfit.
check_dump() {
  _f=$1
  _maxage=${2:-8}
  [ -n "${_f:-}" ] && [ -f "$_f" ] || { echo "no database dump exists to back up"; return 1; }
  [ -s "$_f" ] || { echo "$(basename "$_f") is empty"; return 1; }

  _age=$(( ( $(date -u +%s) - $(stat -c %Y "$_f") ) / 3600 ))
  if [ "$_age" -gt "$_maxage" ]; then
    echo "newest dump $(basename "$_f") is ${_age}h old — stale, not treating this as a backup"
    return 1
  fi
  # A dump truncated by a full disk or a killed container is a non-empty file that
  # only fails months later, in the restore nobody rehearsed.
  gzip -t "$_f" 2>/dev/null || { echo "$(basename "$_f") is not a readable gzip stream — incomplete dump"; return 1; }

  _man="${_f%.archive.gz}.manifest.json"
  [ -f "$_man" ] || { echo "$(basename "$_f") has no manifest — a restore could not be verified"; return 1; }
  _want=$(sed -n 's/.*"sha256":"\([a-f0-9]*\)".*/\1/p' "$_man")
  _got=$(sha256sum "$_f" | cut -d' ' -f1)
  [ -n "$_want" ] || { echo "$(basename "$_man") records no checksum"; return 1; }
  [ "$_want" = "$_got" ] || { echo "$(basename "$_f") does not match its manifest checksum"; return 1; }

  # A manifest with no collection counts cannot prove a restore is complete.
  grep -q '"counts":{.*:' "$_man" || { echo "$(basename "$_man") carries no collection counts"; return 1; }
  return 0
}
