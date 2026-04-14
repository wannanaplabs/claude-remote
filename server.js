// claude-remote: a tiny web bridge so you can drive Claude Code CLI sessions
// from your phone over Tailscale. Each "chat" is a tmux session running
// `claude`, so sessions survive disconnects and you can still `tmux attach`
// from a terminal.
//
// Endpoints:
//   GET  /api/sessions                  -> list tmux sessions (name, cwd, busy)
//   POST /api/sessions                  -> { name, cwd } create a new session
//   DELETE /api/sessions/:name          -> kill a session
//   WS   /ws/:name                      -> bidirectional pty stream (xterm.js)
//   POST /api/ntfy-test                 -> send a test push
//
// Auth: none. Bind to the Tailscale IP so only your tailnet can reach it.

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const PORT = Number(process.env.PORT || 8765);
const BIND = process.env.BIND || "0.0.0.0"; // set to your tailscale IP for safety
const SESSION_PREFIX = process.env.SESSION_PREFIX || "cc-"; // tmux session prefix
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude";
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
const NTFY_TOPIC = process.env.NTFY_TOPIC || ""; // e.g. "claude-frank-9x7q"
const IDLE_PING_MS = Number(process.env.IDLE_PING_MS || 30_000);
// Absolute path recommended: node-pty's posix_spawnp doesn't always honour
// the same PATH Node uses, so "tmux" alone can fail with posix_spawnp error.
const TMUX_BIN = process.env.TMUX_BIN || "tmux";

// ---------- tmux helpers ----------

function tmux(args, opts = {}) {
  const r = spawnSync(TMUX_BIN, args, { encoding: "utf8", ...opts });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`tmux ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

// Heuristic: Claude CLI sets its argv[0] to its version string
// (e.g. "2.1.108"), so tmux's pane_current_command shows that, not "claude".
// We also accept literal "claude" in case that ever changes.
const isClaudePane = (cmd) => cmd === "claude" || /^\d+\.\d+(\.\d+)?$/.test(cmd);

function listPaneCommands() {
  try {
    const out = tmux(
      ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}"],
      { allowFail: true }
    );
    const map = new Map();
    for (const line of (out || "").trim().split("\n").filter(Boolean)) {
      const [sess, cmd] = line.split("\t");
      if (!map.has(sess)) map.set(sess, []);
      map.get(sess).push(cmd);
    }
    return map;
  } catch {
    return new Map();
  }
}

function listSessions() {
  try {
    const out = tmux(
      [
        "list-sessions",
        "-F",
        "#{session_name}\t#{session_path}\t#{session_attached}\t#{session_activity}",
      ],
      { allowFail: true }
    );
    if (!out) return [];
    const paneMap = listPaneCommands();
    return out
      .trim()
      .split("\n")
      .map((l) => {
        const [rawName, cwd, attached, activity] = l.split("\t");
        const managed = rawName.startsWith(SESSION_PREFIX);
        const cmds = paneMap.get(rawName) || [];
        return {
          name: managed ? rawName.slice(SESSION_PREFIX.length) : rawName,
          rawName,
          managed,
          hasClaude: cmds.some(isClaudePane),
          currentCommand: cmds[0] || "",
          cwd,
          attached: attached !== "0",
          lastActivity: Number(activity) * 1000,
        };
      });
  } catch {
    return [];
  }
}

function sessionExists(rawName) {
  const r = spawnSync(TMUX_BIN, ["has-session", "-t", rawName]);
  return r.status === 0;
}

function createSession(name, cwd) {
  const rawName = SESSION_PREFIX + name;
  if (sessionExists(rawName)) throw new Error("session exists");
  if (!fs.existsSync(cwd)) throw new Error(`cwd not found: ${cwd}`);
  tmux([
    "new-session",
    "-d",
    "-s",
    rawName,
    "-c",
    cwd,
    "-x",
    "200",
    "-y",
    "50",
    CLAUDE_CMD,
  ]);
  return rawName;
}

function killSession(name) {
  const rawName = SESSION_PREFIX + name;
  tmux(["kill-session", "-t", rawName], { allowFail: true });
}

// ---------- ntfy push ----------

async function ntfyPush(title, message) {
  if (!NTFY_TOPIC) return;
  try {
    await fetch(`https://ntfy.sh/${NTFY_TOPIC}`, {
      method: "POST",
      headers: { Title: title, Tags: "robot_face", Priority: "default" },
      body: message,
    });
  } catch (e) {
    console.warn("ntfy push failed:", e.message);
  }
}

// ---------- HTTP ----------

const app = express();
app.use(express.json());
// Log every request so we can see what the phone actually sends.
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url} ua="${(req.headers["user-agent"]||"").slice(0,60)}"`);
  next();
});
// Force-fresh HTML/JS so iOS Safari doesn't serve stale code after edits.
app.use((req, res, next) => {
  if (req.path === "/" || req.path.endsWith(".html") || req.path.endsWith(".js")) {
    res.set("Cache-Control", "no-store");
  }
  next();
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions());
});

app.post("/api/sessions", (req, res) => {
  const { name, cwd } = req.body || {};
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    return res.status(400).json({ error: "invalid name" });
  }
  try {
    createSession(name, cwd || DEFAULT_CWD);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/sessions/:name", (req, res) => {
  // Managed-only: we refuse to kill sessions outside our prefix so the
  // phone UI can never accidentally take down unrelated tmux sessions.
  killSession(req.params.name);
  res.json({ ok: true });
});

app.post("/api/ntfy-test", async (_req, res) => {
  await ntfyPush("claude-remote", "test ping");
  res.json({ ok: !!NTFY_TOPIC });
});

// ---------- WebSocket: pipe tmux attach <-> client ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track idle-timer per session so we only ping once per "waiting" period.
const idleTimers = new Map();

// Log WS upgrade attempts before they reach the `connection` handler.
server.on("upgrade", (req, _socket, _head) => {
  console.log(`[ws] upgrade ${req.url} from ${req.socket.remoteAddress}`);
});

wss.on("connection", (ws, req) => {
  console.log(`[ws] connection accepted ${req.url}`);
  const url = new URL(req.url, "http://x");
  // Two shapes:
  //   /ws/<short>        — managed session (we prepend SESSION_PREFIX)
  //   /ws-raw/<rawname>  — any tmux session, already-prefixed name passed verbatim
  const managedMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
  const rawMatch = url.pathname.match(/^\/ws-raw\/([a-zA-Z0-9_.\-]+)$/);
  let rawName;
  if (managedMatch) {
    rawName = SESSION_PREFIX + managedMatch[1];
  } else if (rawMatch) {
    rawName = decodeURIComponent(rawMatch[1]);
  } else {
    return ws.close(1008, "bad path");
  }
  if (!sessionExists(rawName)) return ws.close(1008, "no such session");
  const name = rawName.startsWith(SESSION_PREFIX)
    ? rawName.slice(SESSION_PREFIX.length)
    : rawName;

  const cols = Number(url.searchParams.get("cols") || 100);
  const rows = Number(url.searchParams.get("rows") || 32);

  // Attach a fresh pty to the tmux session. Using `-r` would be read-only;
  // we want interactive. `-d` detaches other clients to keep things tidy,
  // but we skip it so multiple phones/desktops can co-watch.
  // node-pty's posix_spawnp is stricter about PATH than Node's own spawn,
  // so we use the absolute TMUX_BIN to avoid "posix_spawnp failed".
  // Also strip TMUX env so we don't refuse to nest if the server itself
  // happens to live inside a tmux session.
  const childEnv = { ...process.env };
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;
  let term;
  try {
    term = pty.spawn(
      TMUX_BIN,
      ["attach-session", "-t", rawName],
      {
        name: "xterm-256color",
        cols,
        rows,
        cwd: process.env.HOME,
        env: childEnv,
      }
    );
  } catch (err) {
    console.error(`pty.spawn failed for ${rawName}:`, err.message);
    try { ws.send(`\r\n[claude-remote] failed to attach: ${err.message}\r\n`); } catch {}
    return ws.close(1011, "pty spawn failed");
  }

  const armIdle = () => {
    if (idleTimers.has(name)) clearTimeout(idleTimers.get(name));
    idleTimers.set(
      name,
      setTimeout(() => {
        ntfyPush(`Claude [${name}] may need input`, "Session has been idle.");
      }, IDLE_PING_MS)
    );
  };

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
    armIdle();
  });

  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (msg) => {
    // Client frames: either raw bytes, or a JSON control message starting with \x01.
    const str = msg.toString();
    if (str.startsWith("\x01")) {
      try {
        const ctl = JSON.parse(str.slice(1));
        if (ctl.type === "resize") {
          term.resize(Number(ctl.cols) || cols, Number(ctl.rows) || rows);
        }
      } catch {}
      return;
    }
    term.write(str);
  });

  ws.on("close", () => {
    try {
      term.kill();
    } catch {}
  });
});

server.listen(PORT, BIND, () => {
  console.log(`claude-remote listening on http://${BIND}:${PORT}`);
  console.log(`  session prefix: ${SESSION_PREFIX}`);
  console.log(`  default cwd:    ${DEFAULT_CWD}`);
  console.log(`  ntfy topic:     ${NTFY_TOPIC || "(disabled)"}`);
});
