# Running it

How to configure, back up, upgrade and fix a running install. Setting up
YouTube, Twitch, Planning Center and alerts is in
[setup-services.md](./setup-services.md).

## Configuration

Everything is set with environment variables. Two of them also have a
command-line flag, and the flag wins.

| Variable / flag                              | Default                 | Accepted values                                                                                                            |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SCHEDULER_CONFIG_DIR`, `--config-dir <dir>` | per platform, see below | A directory. Holds `scheduler.db`, `master.key` and `master.salt`                                                          |
| `SCHEDULER_BACKUP_DIR`, `--backup-dir <dir>` | `<config dir>/backups`  | A directory for scheduled backups                                                                                          |
| `SCHEDULER_SECRET`                           | unset                   | At least 16 characters. A shorter value stops the app at start when it is used                                             |
| `SCHEDULER_HOST`                             | `127.0.0.1`             | An address to listen on. `0.0.0.0` in the Docker image                                                                     |
| `SCHEDULER_PORT`                             | `8500`                  | A port number                                                                                                              |
| `SCHEDULER_UI_PASSWORD`                      | unset                   | Any password. Copied into the database once, then ignored                                                                  |
| `SCHEDULER_TRUSTED_NETWORK`                  | no                      | Yes or no. Silences the no-password warning. Adds no protection                                                            |
| `SCHEDULER_LOG_LEVEL`                        | `info`                  | `debug`, `info`, `warn` or `error`                                                                                         |
| `SCHEDULER_PUBLIC_URL`                       | learnt                  | The address people use, e.g. `https://stream.example.org`. Without it, learnt from the first signed-in page load           |
| `SCHEDULER_TRUSTED_PROXY`                    | no                      | Yes or no. Set behind a reverse proxy, so the login throttle counts people rather than the proxy                           |
| `SCHEDULER_ALLOWED_HOSTS`                    | unset                   | Comma-separated host names. Once set, requests for any other name are refused, apart from loopback, IPs and the public URL |

Yes is `true`, `1`, `yes` or `on`, in any case. Anything else is no, including
an empty value.

The default config directory:

| Platform | Path                                                                 |
| -------- | -------------------------------------------------------------------- |
| macOS    | `~/Library/Application Support/StreamScheduler`                      |
| Windows  | `%APPDATA%\StreamScheduler`                                          |
| Linux    | `$XDG_CONFIG_HOME/stream-scheduler`, or `~/.config/stream-scheduler` |
| Docker   | `/config`                                                            |

The desktop app is different. It keeps its data in Electron's own user data
directory, and reads only `SCHEDULER_PORT` and `SCHEDULER_UI_PASSWORD`.

## Keeping the key

Stream keys, device passwords and OAuth tokens are encrypted in the database.
The master key that opens them is never in the database, and never in a
backup. Lose it and those secrets are gone. The schedule itself survives.

Where the key lives depends on where it came from. The app takes the first of
these it finds:

1. **The OS keychain.** Desktop app only. The key is stored as
   `master.key.enc` in the app's data directory, encrypted by the OS. It is tied
   to that machine and that user account, so it cannot be moved anywhere else.
2. **`master.key`** in the config directory. 32 random bytes.
3. **`SCHEDULER_SECRET`.** The key is derived from it and a random salt. The
   salt is written to `master.salt` in the config directory on first use.
4. **Nothing found.** The app creates `master.key` on first start.

Once `master.key` exists, `SCHEDULER_SECRET` is ignored.

Keep a copy of the key apart from the backups. With `master.key`, copy the
file. With `SCHEDULER_SECRET`, keep the value in a password manager. The salt
travels inside each backup, so you do not need to copy `master.salt` as well.

Do not change `SCHEDULER_SECRET` on a running install. A different value
derives a different key, and every stored secret becomes unreadable. You
would have to enter every stream key and reconnect every account again.

Settings shows which source this install uses.

## Backups and restore

A backup is one SQLite file: a consistent copy of the database, taken while
the app runs. It also records which master key its secrets need, and the
`SCHEDULER_SECRET` salt if there is one. It never contains the key.

The app takes one every 24 hours and keeps the last 14, in the backup
directory. Both numbers, and whether it runs at all, are under **Settings >
Backup**. You can also download one there at any time. A backup that fails to
write sends an alert.

The backup directory is under the config directory unless you set
`SCHEDULER_BACKUP_DIR`. The supplied `docker-compose.yml` points it at a
second volume, `/backups`. Put that volume on another disk or a NAS if you
want the backups to outlive the machine.

To restore:

1. Upload the file under **Settings > Restore**.
2. Read what it says: what is in the file, and whether this install has the
   key its secrets need.
3. Confirm. The restore is staged, not applied.
4. Restart the app, e.g. `docker restart scheduler`.

On the restart the staged file replaces the database before anything opens
it. The old database is kept beside it as `scheduler.db.replaced-<time>`.
A staged restore can be cancelled until then.

If the key does not match, everything restores except the secrets. Put the
original key in place and restart, or enter the stream keys and reconnect the
accounts again.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

Or `docker pull` the new image and recreate the container with the same
volumes. Database migrations run on start.

There is no downgrade. An older build refuses to open a database a newer one
has migrated, and says so. Take a backup before you upgrade, so you can go
back to it with the older image.

## Lost password

The password is stored hashed, in the `setting` table of `scheduler.db`.
Setting `SCHEDULER_UI_PASSWORD` again does not reset it: that variable is only
read once.

To clear it, stop the app and delete the row:

```bash
docker stop scheduler
sqlite3 /path/to/config/scheduler.db "DELETE FROM setting WHERE key = 'ui_password';"
docker start scheduler
```

The app then starts unlocked. Set a new password under **Settings**.

To have `SCHEDULER_UI_PASSWORD` seed a new one instead, also delete the
`ui_password_seeded_at` row before starting.

`sqlite3` is not in the image. Run it on the host against the volume's
directory, or copy the database out and back.

## Troubleshooting

**Logs** go to stdout as one JSON object per line. Nothing is written to a
log file. In Docker, read them with `docker logs scheduler`. Set
`SCHEDULER_LOG_LEVEL=debug` for more.

**Health.** `GET /healthz` answers `{"ok":true}` once the app is up. It needs
no password. The Docker image's health check uses it.

**`EACCES` on start** means the container cannot write its config or backup
directory. The container runs as uid 10001. Named volumes are set up for that.
A bind mount of a host directory keeps the host's ownership, so fix it on the
host:

```bash
sudo chown -R 10001:10001 /path/to/config /path/to/backups
```

**`SCHEDULER_SECRET must be at least 16 characters.`** Use a longer value.

**`is not a 32-byte key`** means `master.key` is damaged. Put the good copy
back. Deleting it makes a new key, and the stored secrets are lost.

## Timezones

Every event has its own IANA timezone, such as `Europe/London`. A new event
starts with the browser's zone. Recurrence, daylight saving, name templates
and the times in alerts all use the event's zone.

The container's `TZ` changes nothing. Times are stored in UTC, and log
timestamps are written in UTC.
