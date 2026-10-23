# ttt20.peerivo.net — REG.RU 1

Independent deployment of `TicTacToe2.0` from `master`.

- DNS: Cloudflare DNS-only A `ttt20.peerivo.net → 95.163.223.68`.
- Runtime: isolated Docker Compose Socket.IO backend, `127.0.0.1:3530 → container:3000`.
- Static frontend: `/var/www/ttt20.peerivo.net/public/` (only `index.html`, `app.js`, `server/game-rules.js`). Do not expose the server sources.
- Nginx: `/etc/nginx/bx/site_ext_enabled/ttt20.peerivo.net.conf`, template in this directory.
- Certificate: Let's Encrypt via `certbot certonly --webroot -w /var/www/ttt20.peerivo.net/acme -d ttt20.peerivo.net`.
- The dedicated domain connects to same-origin Socket.IO, GitHub Pages retains its Railway endpoint.
- `docker compose -f deploy/ttt20/compose.yaml up -d --build`, inspect health with `curl https://ttt20.peerivo.net/health`.
- Multiplayer room, session, move, score and next-round timer are durable in SQLite via `ttt20_ttt20_room_data:/data` (separate Docker volume).
- At the end of each round, both players see the result for 7 seconds before the server starts the next round. Starter rotates X → O → X without a new invitation.
- A verified daily database backup is configured in `/etc/cron.d/peerivo-ttt20-backup`; private backups are in `/opt/peerivo/backups/ttt20` (14 days). To force a backup: `bash /opt/peerivo/ttt20/deploy/ttt20/backup.sh`.
- Backup/restore and constraints: `docs/adr/001-persistent-rooms-and-alternating-starters.md`.
- To use this domain in Telegram Mini App, set the Web App URL for `@tictactoe20_bot` in BotFather to `https://ttt20.peerivo.net/`.
