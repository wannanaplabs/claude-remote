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

```bash
npm start
```

On macOS the server auto-fixes the usual setup hiccups at boot:

- restores `chmod +x` on `node_modules/node-pty/prebuilds/*/spawn-helper`
  if npm stripped it (otherwise `pty.spawn` throws `posix_spawnp failed`);
- resolves `tmux`'s absolute path, since node-pty's `posix_spawnp` doesn't
  always honour Homebrew's `PATH`;
- defaults `BIND` to your Tailscale IP if `tailscale` is on `PATH`, so the
  listener is only reachable over the tailnet.

Override anything via env vars or a `.env` file — see the config table below.

Then on your phone: open `http://<your-mac-name>:8765`
(e.g. `http://franks-macbook:8765` — Tailscale's MagicDNS gives you the name).

### Adding a password (recommended)

Tailscale is already a real trust boundary, but a one-line password adds a
second factor so that a compromised tailnet member can't silently drive
your Claude session. Two equivalent ways to set it:

```bash
# 1. Inline
AUTH_PASSWORD='pick-a-long-random-string' npm start

# 2. .env file (preferred for persistent setups)
cp .env.example .env
$EDITOR .env                    # fill in AUTH_PASSWORD
npm start                       # dotenv loads .env automatically
```

The `.env` file is gitignored, so it won't leak into version control.

On first visit you'll land on a simple `/login` page with a single password
field (no username). Submit it once; the server sets a year-long HttpOnly
cookie and you're never asked again on that device. iOS Safari offers to
save the password in iCloud Keychain too, so the one-time entry is really
one tap.

Implementation details:

- The cookie value is `HMAC-SHA256(password, "claude-remote")`, so it's
  stable across server restarts (no need to re-login when you restart the
  server) but invalidates automatically the moment you rotate
  `AUTH_PASSWORD`.
- Password comparisons use `crypto.timingSafeEqual`, so there's no timing
  leak.
- If the cookie ever stops validating (rotated password, cleared cookies),
  the web app redirects to `/login` automatically.
- If `AUTH_PASSWORD` is empty/unset, auth is disabled and the server logs
  `auth: DISABLED` on startup.

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
| `TMUX_BIN`       | `tmux`            | Absolute path to tmux if node-pty can't find it (e.g. `/opt/homebrew/bin/tmux`) |
| `AUTH_PASSWORD`  | *(empty)*         | If set, HTTP and WebSocket require the cookie-based login. Leave empty to disable. |

## Recommended host setup

Two small bits of config on the Mac that make this a lot nicer to live with.

### `~/.tmux.conf` — mouse scroll + more history

Without this, scroll wheel does nothing inside tmux (tmux captures all output
into its own scrollback, but doesn't forward mouse events by default).

```tmux
set -g mouse on
set -g history-limit 50000
set -g default-terminal "screen-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
```

Apply without restart: `tmux source-file ~/.tmux.conf`.

### VS Code: auto-wrap every integrated terminal in tmux

Two profiles, so you can pick reattach vs fresh-per-terminal behavior:

- **`claude-tmux`** — reattaches to a single `cc-<workspace>` session every
  time. Good when you want VS Code to "resume" what you had running.
- **`claude-tmux-new`** — each new terminal starts a fresh numbered session
  (`cc-<workspace>-1`, `-2`, `-3`, …), so every `+` in the terminal tab bar
  is an independent tmux session that also shows up as its own row on the
  phone.

1. Save this helper as `~/bin/cc-tmux-new` and `chmod +x` it:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   TMUX_BIN="${TMUX_BIN:-/opt/homebrew/bin/tmux}"
   base="cc-${1:-$(basename "$PWD")}"
   n=1
   while "$TMUX_BIN" has-session -t "${base}-${n}" 2>/dev/null; do
     n=$((n + 1))
   done
   exec "$TMUX_BIN" new-session -s "${base}-${n}"
   ```

2. Add to `~/Library/Application Support/Code/User/settings.json`:

   ```json
   {
     "terminal.integrated.profiles.osx": {
       "claude-tmux": {
         "path": "/opt/homebrew/bin/tmux",
         "args": ["new-session", "-A", "-s", "cc-${workspaceFolderBasename}"],
         "icon": "terminal-tmux"
       },
       "claude-tmux-new": {
         "path": "/Users/YOUR_USER/bin/cc-tmux-new",
         "args": ["${workspaceFolderBasename}"],
         "icon": "terminal-tmux"
       }
     },
     "terminal.integrated.defaultProfile.osx": "claude-tmux-new"
   }
   ```

Pick which one you want as the default. With `claude-tmux-new` as default,
every `+` creates a new numbered session — very simple mental model, and
every terminal becomes a separate row on your phone. The tradeoff is that
reopening VS Code creates a new session instead of reattaching (use the
terminal dropdown → `claude-tmux` when you specifically want to reattach).

Use the absolute tmux path (`/opt/homebrew/bin/tmux`) since VS Code's GUI
launch doesn't always pick up Homebrew's `PATH`. Replace `YOUR_USER` with
your macOS username.

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

- Layer 1 — network: `BIND` to the Tailscale IP keeps the listener inside
  your tailnet. Don't expose port 8765 to the public internet.
- Layer 2 — password: set `AUTH_PASSWORD` for HTTP Basic Auth on every
  request and WS upgrade (constant-time compare, no timing leak). Prevents
  a compromised tailnet member from silently driving a Claude session.
- Layer 3 — per-user identity: front it with
  [`tailscale serve`](https://tailscale.com/kb/1242/tailscale-serve) and
  read the `Tailscale-User-Login` header if you want actual identity.
- Anyone who gets past all three can run shell commands (Claude can run
  shell). That's the same trust model as SSH to your Mac.

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
