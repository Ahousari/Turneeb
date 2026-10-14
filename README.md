# Tarneeb with friends

A browser game for four seats in two partnerships. Use 1–4 human players and computers for the remaining seats. The original standalone game is preserved in `tarneeb.html`.

## Play on this computer

Install [Node.js 22 or newer](https://nodejs.org/), then double-click **Start Tarneeb.bat**. Open **http://localhost:3000** and create a table. The launcher installs the one required package on its first run. Keep its terminal open while playing.

Or run these commands in this folder:

```powershell
npm.cmd ci
npm.cmd start
```

Create a table, open **Players**, select computer difficulties and personalities, and deal. Solo play uses three bots automatically.

## Invite friends and choose teams

- Use **Copy invitation**. Friends enter their name and select an available seat.
- Seats **1 + 3** are one team; seats **2 + 4** are the other. Every player sees themselves at the bottom of the table.
- Before the match or between hands, the host can swap players between seats, choose bots, or mark empty seats as waiting for friends. Waiting seats must be filled before starting.
- During a hand, a new friend can reserve a bot seat. They see the public table and receive their own cards on the next deal.
- The host deals the next hand, pauses the table, and can pass host controls to another connected player.
- A refresh or brief connection interruption restores the same seat in the same browser. After **30 seconds disconnected**, a bot takes over until the next hand. If the host stays disconnected, controls pass to a connected friend after the same grace period.
- A disconnected guest's seat can be released by the host. This cancels the old guest's seat reservation. Connected guests cannot be removed this way.

The table invitation grants the ability to join an available seat. Keep it within your group. Your private seat credential stays in your browser and is never included in invitations. Clearing browser storage or switching devices requires joining again; the host can release your old seat if needed.

## Free online hosting on Render

The repository includes `render.yaml` for a free Node web service. The actual address is assigned by Render and remains stable for that service. The game runs on Render, so your computer can be off.

1. Sign in to GitHub and create a repository for the game. Upload the source files in this folder, including `package.json`, `package-lock.json`, `server.js`, `lib/`, `public/`, and `render.yaml`. Exclude `node_modules/`, `.npm-cache/`, and `data/`. The `.gitignore` handles these when using Git. `test/`, this README, and the local launcher may also be included.
2. Sign in to [Render](https://dashboard.render.com/) and authorize access to that repository.
3. Create a **Blueprint** from the repository to use `render.yaml`. Verify that the service uses the **Free** plan before creating it.
4. Alternatively, create a **Web Service** with runtime **Node**, build command `npm ci --omit=dev`, start command `npm start`, health check `/healthz`, and the **Free** instance type. Set `NODE_VERSION=22.20.0` and `ROOM_STORE=none`.
5. Open the service's HTTPS address, create a table, and copy its invitation. Send that public link rather than a localhost link.
6. Test the public invitation on a phone using mobile data, then with a friend on another network. Verify joining, bidding, playing a card, and refreshing without losing the seat.

An account owner must complete sign-in and authorization steps. No paid resources are included in the Blueprint.

### What the free server saves

Render's free server sleeps after 15 minutes without incoming traffic, and the first visitor may wait about one minute for it to wake up. Connected clients respond to WebSocket heartbeats during play. Render currently grants 750 free instance hours per workspace per calendar month, with separate bandwidth and build quotas. See [Render's free limits](https://render.com/docs/free) for current details and account-wide usage.

**On the free Render configuration, rooms and unfinished matches disappear if the service restarts, redeploys, or sleeps.** Refreshing a browser or reconnecting to a running server preserves your seat and match. The permanent site address continues to work; create a new table if an old room has expired. Durable online match saves would require a separate persistent storage service; this version does not provision one.

When hosted on your computer, rooms save automatically to `data/rooms.json`, including private hands and seat credentials. This folder is private and excluded from Git. Local rooms expire after 24 hours without connected players. Back up `data/` if you need to preserve local matches. A corrupt save causes startup to stop rather than silently overwrite it.

## Other devices on the same Wi-Fi

The server listens on all network interfaces. On the host computer, run `ipconfig` and find the active Wi-Fi/Ethernet adapter's IPv4 address. On another device, open `http://THAT-IP:3000`, then create or join a table. If Windows asks, allow Node.js on your private network. Invitations copied from this LAN address work for devices on the same network.

`localhost` always means the device opening the link. A localhost invitation cannot be sent to another device. LAN addresses are also unavailable across unrelated networks. Use the Render HTTPS address for friends elsewhere. If you later prefer local internet hosting, the server can also run behind a configured Tailscale Funnel.

## Validation and implementation

```powershell
npm.cmd run check
npm.cmd test
```

Tests cover scoring, follow-suit rules, 50 complete computer hands, private observations, host authorization, seat reservations, stale requests, disconnect takeover, local recovery, HTTP restrictions, and four real WebSocket clients completing a hand and reconnecting.

- Node's HTTP server serves the interface and validates room creation/joining.
- WebSocket connections authenticate with private seat credentials; the server validates every move and sends only that player's hand plus public information.
- Expert computer simulations run on a reusable worker thread so network connections stay responsive. Computers cannot inspect other players' hands.
- Browser dialogs do not pause shared play. Pause is an explicit host action.
- Server snapshots use atomic local file replacement when local storage is enabled. `ROOM_STORE=none` disables disk saves; `ROOM_STORE` can also specify a file on persistent storage you manage.
- No analytics, third-party scripts, registration, or chat messages are sent by the game.

## Troubleshooting

- **Server address is already in use:** close the existing game server, or set a different `PORT` before starting. Update invitation addresses accordingly.
- **Table expired:** the online server restarted, or the room was inactive for 24 hours. Create a new room and share its new invitation.
- **All seats reserved:** the host can release a disconnected guest's seat in Players.
- **Bot is playing my hand after reconnect:** wait for the next deal; the bot finishes the current hand to prevent mid-hand control changes.
- **Online deployment fails:** verify the repository contains the complete `lib/` and `public/` folders and the lockfile. Use a Node Web Service, not a Static Site.

Rules and bot strategies were extracted from the original local game with `scripts/extract-original.cjs`. That script is a one-time development utility, not a build step; avoid rerunning it after making engine or card changes.
