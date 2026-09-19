#!/bin/sh
# What the nightly job refuses. Crafted files in a temp directory; touches nothing real.
. /root/dump-check.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok() { if [ "$2" = "$3" ]; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ FAIL: $1 (expected $3, got $2)"; fail=$((fail+1)); fi; }

mk_good() {
  printf 'pretend this is a mongodump archive\n' | gzip > "$T/examopia-good.archive.gz"
  SHA=$(sha256sum "$T/examopia-good.archive.gz" | cut -d' ' -f1)
  printf '{"archive":"examopia-good.archive.gz","takenAt":"now","bytes":1,"sha256":"%s","counts":{"users":3,"boards":92}}\n' "$SHA" > "$T/examopia-good.manifest.json"
}

echo "the nightly job accepts a whole, fresh, checksum-matched dump"
mk_good
check_dump "$T/examopia-good.archive.gz" 8 >/dev/null; ok "a good dump passes" "$?" "0"

echo "and refuses everything else"
check_dump "$T/nothing-here.archive.gz" 8 >/dev/null; ok "a missing dump" "$?" "1"
: > "$T/examopia-empty.archive.gz"
check_dump "$T/examopia-empty.archive.gz" 8 >/dev/null; ok "an empty dump" "$?" "1"

mk_good
touch -d "20 hours ago" "$T/examopia-good.archive.gz"
REASON=$(check_dump "$T/examopia-good.archive.gz" 8); ok "a stale dump (older than the window)" "$?" "1"
case "$REASON" in *stale*) echo "  ✓ and says why: $REASON"; pass=$((pass+1));; *) echo "  ✗ FAIL: unclear reason: $REASON"; fail=$((fail+1));; esac

mk_good
printf 'not gzip at all' > "$T/examopia-good.archive.gz"
check_dump "$T/examopia-good.archive.gz" 8 >/dev/null; ok "a truncated / non-gzip dump" "$?" "1"

mk_good
rm -f "$T/examopia-good.manifest.json"
check_dump "$T/examopia-good.archive.gz" 8 >/dev/null; ok "a dump with no manifest" "$?" "1"

mk_good
# A perfectly valid gzip — but NOT the one the manifest was written for. This is
# the substitution/bit-rot case, so it must fail on the checksum, not on gzip.
printf 'a different dump entirely\n' | gzip > "$T/examopia-good.archive.gz"
REASON=$(check_dump "$T/examopia-good.archive.gz" 8); ok "a dump that no longer matches its checksum" "$?" "1"
case "$REASON" in *checksum*) echo "  ✓ and says why: $REASON"; pass=$((pass+1));; *) echo "  ✗ FAIL: unclear reason: $REASON"; fail=$((fail+1));; esac

mk_good
SHA=$(sha256sum "$T/examopia-good.archive.gz" | cut -d' ' -f1)
printf '{"archive":"x","takenAt":"now","bytes":1,"sha256":"%s","counts":{}}\n' "$SHA" > "$T/examopia-good.manifest.json"
check_dump "$T/examopia-good.archive.gz" 8 >/dev/null; ok "a manifest with no collection counts" "$?" "1"

echo "and the REAL dump on this server passes"
REAL=$(ls -t /root/backups/mongo/nightly/examopia-*.archive.gz 2>/dev/null | head -1)
REASON=$(check_dump "$REAL" 24); ok "tonight's actual dump" "$?" "0"
[ -n "$REASON" ] && echo "    ($REASON)"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
