# Restoring Examopia from the off-server backup

Written for whoever has to bring the platform back — possibly on a brand-new
server, possibly without the old one to look at.

## What is in the backup

One encrypted BorgBackup repository on the Hetzner Storage Box, archive per night,
named `examopia-YYYYMMDD-HHMM`. It holds:

- `/root/backups/mongo/nightly/` — the database dumps (`mongorestore` archives)
- the file volumes: `videos`, `assignments`, `materials`, `curriculum`,
  `guidevideos`, `exampdfs`, `boardfiles`, `uploads`
- the server config needed to run again: `.env`, `docker-compose.yml`, `Caddyfile`,
  `mongo-keyfile`

NOT in it, on purpose:

- `wa_auth` (WhatsApp sessions) — re-scan the QR codes instead; they are live logins
- `mongo_data` — the live database files. Copying those while Mongo runs is not a
  consistent backup; the dumps are the consistent copy.

## The two secrets you need

Without these the backup is unreadable — that is the point of encrypting it.

1. `/root/.borg-pass` — the repository passphrase
2. `/root/.borg-repokey` — the exported repository key

**Keep a copy of both somewhere that is not this server and not the Storage Box**
(a password manager). If the server dies with the only copy, the backup is lost
with it.

## Restore

```sh
export BORG_PASSPHRASE='<contents of .borg-pass>'
export BORG_RSH='ssh -i /root/.ssh/storagebox_ed25519 -p 23'
REPO="ssh://uXXXXXX@uXXXXXX.your-storagebox.de:23/./examopia-borg"

borg list "$REPO"                      # pick a night
borg extract "$REPO::examopia-20260920-0315"   # extracts into the current directory
```

On a fresh machine, import the key first: `borg key import "$REPO" .borg-repokey`.

### Database

```sh
# with the mongo container running (docker compose up -d mongo)
. /root/.mongo-admin
docker compose exec -T mongo mongorestore --gzip --archive=/backups/examopia-YYYYMMDD-HHMM.archive.gz \
  --drop -u admin -p "$MONGO_ADMIN_PASSWORD" --authenticationDatabase admin
```

`--drop` replaces each collection as it restores it. Restore into an EMPTY database
if you are rebuilding, and think twice before running it against a live one.

### Files

Copy each extracted volume directory back into
`/var/lib/docker/volumes/examopia-backend_<name>/_data`, then
`docker compose up -d --build`.

### Afterwards

- Re-scan the three WhatsApp QR codes from the admin dashboard.
- Check `https://examopia.com/health` — it reports when the last database backup ran.

## Checking it still works

The backup log is `/root/backups/offsite.log`; every run ends in `ok` or `FAILED`.
Twice a year, actually extract one archive into a scratch directory and open a file
from it. A backup nobody has restored is a backup nobody knows they have.
