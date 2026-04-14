# claude-remote

A tiny mobile-friendly web app so you can drive Claude Code CLI sessions
from your phone over Tailscale. Each "chat" is a `tmux` session running
`claude`, so sessions survive phone disconnects and you can still
`tmux attach` from your Mac terminal.

## What you get

- A phone-first web UI at `http://<mac-tailscale-name>:8765`
- A session picker (tap to open, swipe-close to go back)
- "New session" launcher with a working-directory field
- Quick-action buttons for things that are a pain to type on a phone:
  `Enter`, `Esc`, `y↵`, `n↵`, `Ctrl-C`, `Ctrl-D`, arrows, `/clear`, `/compact`
- A plain text box that sends the message + Enter (chat-app feel)
- Idle-push notifications via [ntfy.sh](https://ntfy.sh) when a session
  has gone quiet (useful when an agentic run is waiting on your approval)

## Prereqs

On the Mac:

```bash
brew install tmux node            # node 20+
npm install -g @anthropic-ai/claude-code
```

Tailscale on the Mac and on your phone (same tailnet). You already planned
to use this.

## Install

```bash
cd /path/to/claude-remote
npm install
```

`node-pty` builds a native module; if it complains, `xcode-select --install`
once and retry.

## Run

Easiest: bind to all interfaces on your tailnet (still private because only
your tailnet can route to it):

```bash
npm start
```

Safer: bind only to the Tailscale IP so even if the Mac is on a coffee-shop
Wi-Fi, the listener isn't reachable from that LAN.

```bash
TS_IP=$(tailscale ip -4 | head -1)
BIND=$TS_IP npm start
```

Then on your phone: open `http://<your-mac-name>:8765`
(e.g. `http://franks-macbook:8765` — Tailscale's MagicDNS gives you the name).

### Optional: keep it running

Simplest is a `launchd` agent. Save as
`~/Library/LaunchAgents/com.frank.claude-remote.plist`, then
`launchctl load` it. Or just run it in a dedicated tmux window — fitting,
since the whole thing is tmux anyway.

## Config (env vars)

| Var              | Default           | What it does                                        |
|------------------|-------------------|-----------------------------------------------------|
| `PORT`           | `8765`            | HTTP/WS port                                        |
| `BIND`           | `0.0.0.0`         | Interface to listen on (set to Tailscale IP)        |
| `SESSION_PREFIX` | `cc-`             | tmux name prefix (so it won't list your other tmux) |
| `CLAUDE_CMD`     | `claude`          | Command to run inside each new session              |
| `DEFAULT_CWD`    | `$HOME`           | Used when "New session" leaves cwd blank            |
| `NTFY_TOPIC`     | *(empty)*         | Your private ntfy.sh topic, e.g. `claude-frank-9x7q`. If empty, push is off. |
| `IDLE_PING_MS`   | `30000`           | How long of "no output" before a push fires        |

For ntfy: install the ntfy app on your phone, subscribe to whatever topic
name you pick (make it random, it's unauthenticated), then set
`NTFY_TOPIC=that-same-name` when starting the server.

## How it works

- Each "chat" is a tmux session named `cc-<your-name>`.
- `POST /api/sessions` runs `tmux new-session -d -s cc-foo -c <cwd> claude`.
- The WebSocket at `/ws/foo` spawns `tmux attach-session -t cc-foo`
  in a pty and pipes bytes both ways to an xterm.js terminal in the browser.
- Because tmux owns the actual pty with `claude` in it, closing your phone
  screen or dropping LTE just detaches your attach — the claude process is
  untouched. Reopen the page and you reattach.
- Multiple devices can attach to the same session simultaneously (nice: you
  can watch from your desktop while typing on your phone).

## Security notes

- There's no app-level auth. The assumption is that `BIND` keeps the
  listener inside your tailnet. Don't expose port 8765 to the public
  internet.
- Anyone on your tailnet who reaches the port can drive any session and
  run shell commands (Claude can run shell). That's already the trust model
  for SSH to your Mac, but worth naming.
- If you want per-user auth, front it with
  [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve) and
  read the `Tailscale-User-Login` header.

## Known rough edges

- xterm.js on mobile Safari: two-finger scroll works; copy/paste uses the
  standard long-press. If the soft keyboard covers the input bar, tap the
  terminal once to blur, then tap the input again.
- Idle-push is a dumb timer, not a "waiting for input" detector. It fires
  any time the session goes quiet for `IDLE_PING_MS`. Tune or disable per
  taste.
- If you kill the server, pty attachments drop but tmux sessions keep
  running. Restart and reconnect — they'll still be there.

## One-liner sanity check before you put it in front of your phone

On the Mac itself, after `npm start`:

```bash
curl -s localhost:8765/api/sessions
# -> []  (empty list, no error)
```

Then open `http://localhost:8765` in Safari on the Mac and make a test
session pointed at `~`. If that works, you're good to go over Tailscale.
