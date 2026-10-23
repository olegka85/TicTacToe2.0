# ADR-001 — Persistent multiplayer room state and alternating starters

Date: 2026-10-24
Status: accepted and implemented

## Scope
On REG.RU 1, each online game is a room with stable X and O identities. The person
opening the invite begins the first round (X). In round 2 the original creator (O)
starts, in round 3 X, and so on, independent of the round winner.

## State and storage
The app has one Node.js server process. Persistence is a local SQLite database
at `ROOM_DB_PATH=/data/rooms.sqlite`, mounted as an isolated Docker named volume
`ttt20_ttt20_room_data`. Each accepted move and room membership update is
committed synchronously before notifying clients. WAL + FULL synchronous mode
provide crash durability. Session tokens, moves, winner, scores, starter,
round number and `nextRoundAt` are persisted; obsolete socket IDs are NOT.

`room-store.js` defaults to a no-op persistence adapter when ROOM_DB_PATH is unset,
to avoid changing old GitHub Pages/Railway deployments.
Production explicitly sets the DB path and requires Node 24+.

The production Docker container runs without root and with a read-only filesystem
except for `/data`. The database directory/files and daily snapshots are private.

## Round lifecycle
1. Invitee X joins the existing room and moves first in round 1.
2. The last valid move stores final board/winner and increments the score exactly once.
3. Both players see the finished board, animation and result for 7 seconds.
4. The server automatically replaces the board and switches starter X ↔ O,
   keeping both player session tokens, room URL and cumulative match score.
5. Finished-round deadlines are restored on startup; if elapsed, the new round starts.
6. Manual online reset is no longer offered in the UI; on the server it is
   accepted only after a round finishes, to skip its 7-second display period.
7. If one player explicitly leaves, the existing previous behaviour remains:
   creator leaving closes the room, invitee leaving resets it to a new invitation.
8. Old rooms are removed after 24 hours waiting or 7 days inactive while
   both participants are disconnected (previous room lifetime behaviour).

## Backups and recovery
Root's cron on REG.RU 1 runs `deploy/ttt20/backup.sh` daily 03:20 UTC.
The script uses SQLite's online `.backup`, validates `PRAGMA quick_check`,
stores files mode 0600 under `/opt/peerivo/backups/ttt20`,
and retains 14 days. No external S3 service required.

To recover, stop only `peerivo-ttt20-socket`, restore a snapshot as
`rooms.sqlite` in the named volume, remove any stale WAL/SHM files only with
the service stopped, then start the container again.

## Operational caveats
A new deployment from an older in-memory server cannot migrate its already-live
rooms (there is no durable source to import). Subsequent restarts preserve rooms.
Single Node worker only; do not scale Socket.IO horizontally without shared store.
