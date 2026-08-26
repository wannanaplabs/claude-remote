# claude-remote

Drive Claude Code CLI sessions from your phone over Tailscale. Each chat is
a `tmux` session on the Mac, so sessions survive disconnects, server restarts,
and dropped WebSockets.

## Install & run

```bash
npm install
npm start
```

Then open `http://<mac-tailscale-name>:8765` on your phone.

Prereqs: Node 20+, `tmux`, and [Claude Code](https://docs.claude.com/claude-code)
on your `PATH` as `claude`. On macOS the server auto-resolves the tmux path,
fixes `node-pty`'s `spawn-helper` exec bit, and defaults `BIND` to your
Tailscale IP if `tailscale` is installed.

## Password (recommended)

```bash
cp .env.example .env
$EDITOR .env           # set AUTH_PASSWORD
npm start
```

First visit prompts at `/login`, then sets a year-long HttpOnly cookie.
iOS Safari offers to save the password in Keychain.

## Config

| Var              | Default    | Notes |
|------------------|------------|-------|
| `PORT`           | `8765`     | |
| `BIND`           | auto       | Defaults to Tailscale IP if available |
| `SESSION_PREFIX` | `cc-`      | tmux name prefix |
| `CLAUDE_CMD`     | `claude`   | Command run for new sessions |
| `DEFAULT_CWD`    | `$HOME`    | |
| `TMUX_BIN`       | auto       | Absolute path if auto-resolve fails |
| `AUTH_PASSWORD`  | *(empty)*  | Enables cookie login |

## Host setup

`~/.tmux.conf` — mouse scroll and bigger history (without this the scroll
wheel does nothing inside tmux):

```tmux
set -g mouse on
set -g history-limit 50000
set -ga terminal-overrides ",xterm-256color:Tc"
```

### VS Code

Auto-wrap every integrated terminal in tmux, in
`~/Library/Application Support/Code/User/settings.json`:

```json
"terminal.integrated.profiles.osx": {
  "claude-tmux": {
    "path": "/opt/homebrew/bin/tmux",
    "args": ["new-session", "-A", "-s", "cc-${workspaceFolderBasename}"]
  }
},
"terminal.integrated.defaultProfile.osx": "claude-tmux"
```

Reattaches to one `cc-<workspace>` session per project. For a new
independent session on every `+`, use a wrapper that picks the next free
`cc-<workspace>-N`.

### Zed

This repo's `.zed/settings.json` runs `scripts/zed-claude-tmux` for every
new integrated terminal. Each terminal creates the next free
`cc-<project>-N` session (`cc-claudeunlocked-1`, `cc-claudeunlocked-2`, …)
and opens your normal shell in it, so it shows up in the phone UI. Run
`claude` in that shell when you want Claude Code.

To use this in every Zed project, copy the `terminal` block into
`~/.config/zed/settings.json` and point `args` at the script by absolute
path.

### Helpers

```bash
./scripts/tmux-sessions-by-mem
```

Lists live tmux sessions heaviest-first by process-tree RSS. Useful when
a Claude session is eating RAM and you need to know which one to kill.

## How it works

The phone UI is a single `public/index.html` (xterm.js) talking to
`server.js` over HTTP + WebSocket. The server never owns the Claude
process — it `tmux attach`s, so:

- Multiple clients can co-watch a session
- `tmux attach -t cc-foo` from a real terminal still works
- Killing the Node process does not kill Claude

New sessions from the drawer run `tmux new-session … claude`. Sessions
created by the Zed/VS Code wrappers start a shell instead; start `claude`
yourself. The drawer can attach to or kill any tmux session, not just
`cc-` ones.

## Security

Trust model: Tailscale is the network boundary, `AUTH_PASSWORD` is the
second factor, cross-origin POST/DELETE and WS upgrades are rejected.
Don't expose port 8765 to the public internet.
