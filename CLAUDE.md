# CLAUDE.md

Project context for Claude Code. Read this first before suggesting changes.

## What this is

`claude-remote` is a tiny self-hosted web app that lets Frank drive Claude
Code CLI sessions from his phone over Tailscale. Each "chat" in the UI is a
`tmux` session on his Mac running `claude`; the server pipes `tmux attach`
through a WebSocket to an xterm.js terminal in the browser.

Design goals, in priority order:

1. **Mobile-first.** Frank is on his phone, often one-handed. Keep the UI
   tight, large tap targets, quick-action buttons above the keyboard.
2. **Resilient to flaky connections.** Sessions live in tmux, not in the
   server process. Server restarts and dropped WebSockets must never kill a
   running Claude session.
3. **Minimal trust surface.** Assume "Tailscale is the auth." Bind to the
   Tailscale IP. No accounts, no OAuth, no database.
4. **Boring stack.** Plain Node + Express + ws + node-pty. No bundler, no
   framework, no TypeScript. HTML/CSS/JS in one file each. If a change
   requires adding a build step, push back.

## Layout

```
claude-remote/
├── server.js          # Express + WebSocket server, tmux session manager
├── public/index.html  # Single-page mobile UI (xterm.js from CDN)
├── package.json       # deps: express, ws, node-pty
├── README.md          # user-facing setup docs
└── CLAUDE.md          # this file
```

## Server architecture (server.js)

- HTTP:
  - `GET  /api/sessions` — list tmux sessions whose names start with
    `SESSION_PREFIX` (default `cc-`). Strips the prefix in the response.
  - `POST /api/sessions` — `{ name, cwd }`. Creates
    `tmux new-session -d -s cc-<name> -c <cwd> claude`.
  - `DELETE /api/sessions/:name` — `tmux kill-session`.
  - `POST /api/ntfy-test` — fires a test ntfy.sh push.
- WebSocket at `/ws/:name`:
  - Spawns a fresh pty running `tmux attach-session -t cc-<name>`.
  - Pipes bytes both ways; first byte `\x01` from the client is a JSON
    control frame (currently only `{type:"resize", cols, rows}`).
- Idle-push: per-session timer re-armed on every byte of output from the
  pty. If nothing comes out for `IDLE_PING_MS` (default 30s), fire an
  ntfy.sh notification. Dumb heuristic, but it's good enough — tune later.

### Why tmux, not raw pty

`claude` running directly in a pty owned by the Node process dies when the
server restarts. Putting tmux between us means:
- Multiple clients can co-watch a session.
- `tmux attach -t cc-foo` from a real terminal still works.
- Node restarts (or crashes) don't kill Claude mid-agentic-run.

If a change proposes removing tmux, stop and flag it — that's the whole
reason the design holds together.

## Client (public/index.html)

- Single file. Imports xterm.js + xterm-addon-fit from jsDelivr.
- Session drawer with list + "new session" form at top.
- xterm.js terminal fills the middle.
- Horizontal quick-action bar: Enter, Esc, y↵, n↵, Ctrl-C, Ctrl-D, ↑/↓,
  `/clear`, `/compact`. These are the exact keys that are painful on iOS.
- Bottom chat-style input: send message + `\r`.

Styling is hand-rolled CSS with a warm dark palette (`--accent: #d97757`,
Anthropic-ish orange). No Tailwind. No framework.

## Conventions

- **No build step.** If a dep needs bundling, it doesn't belong here.
- **ES modules in the browser only.** Server is CommonJS (`require`).
- **Env vars for all config.** Never hardcode ports, paths, topics.
- **No state on disk.** tmux is the source of truth for sessions.
- **Keep files short.** If `server.js` crosses ~400 lines, split by concern
  (e.g. `tmux.js`, `push.js`) — but only then.

## Common tasks and how to approach them

- **Adding a quick-action button:** edit `#qbar` in `public/index.html`.
  `data-send` accepts `\r`, `\n`, `\x03`, `\x04`, `\x1b`, `\x1b[A`,
  `\x1b[B` (the decoder in the click handler is explicit — extend it if
  you need a new escape).
- **Adding a new API endpoint:** put it next to the others in
  `server.js`, above the WebSocket section. Validate `name` with
  `/^[a-zA-Z0-9_-]+$/` — tmux names are used in shell args.
- **Changing the idle detector:** `armIdle()` in the WebSocket handler.
  If you make it smarter (e.g. regex-match Claude's permission prompt),
  keep the dumb timer as a fallback.
- **Per-user auth:** the intended path is `tailscale serve` in front and
  reading the `Tailscale-User-Login` header — don't build app-level
  accounts.

## Non-goals

- Multi-user accounts, sign-up flows, password reset.
- A mobile app (React Native, etc.). The web app is the app.
- Running on the public internet. If this needs to leave the tailnet,
  that's a different project.
- Replacing Claude Code CLI with the Claude Agent SDK. The point is to
  drive the exact CLI, slash commands and all.

## Testing by hand

```bash
# Server sanity
curl -s localhost:8765/api/sessions      # -> []

# Create, list, kill
curl -sX POST localhost:8765/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","cwd":"'"$HOME"'"}'
tmux ls | grep cc-smoke
curl -sX DELETE localhost:8765/api/sessions/smoke
```

## Known rough edges (don't "fix" without asking)

- The idle-push is intentionally dumb — see note above.
- xterm.js on iOS Safari has a finicky soft keyboard. We accept that.
- No rate limiting. Tailscale is the trust boundary; inside it, Frank
  owns the device.
