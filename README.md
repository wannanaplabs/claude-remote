# claude-remote

Drive Claude Code CLI sessions from your phone over Tailscale. Each chat is
a `tmux` session running `claude`, so sessions survive disconnects.

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

VS Code — auto-wrap every integrated terminal in tmux, in
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

## Security

Trust model: Tailscale is the network boundary, `AUTH_PASSWORD` is the
second factor, cross-origin POST/DELETE and WS upgrades are rejected.
Don't expose port 8765 to the public internet.
