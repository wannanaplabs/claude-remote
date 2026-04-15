// See CLAUDE.md for architecture. tl;dr: HTTP + WS bridge that pipes a
// `tmux attach` pty through xterm.js on the phone over Tailscale.

require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const pty = require("node-pty");
const { execSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// npm sometimes strips the exec bit from node-pty's spawn-helper, which
// makes every pty.spawn throw "posix_spawnp failed." Fix idempotently.
for (const arch of ["darwin-arm64", "darwin-x64"]) {
  const helper = path.join(__dirname, "node_modules", "node-pty", "prebuilds", arch, "spawn-helper");
  try {
    const st = fs.statSync(helper);
    if (!(st.mode & 0o111)) fs.chmodSync(helper, st.mode | 0o111);
  } catch {} // file not present for this arch — fine
}

// node-pty's posix_spawnp ignores Node's PATH tweaks, so we hand it an
// absolute tmux path. Falls back to PATH lookup + Homebrew/system defaults.
function resolveTmuxBin() {
  if (process.env.TMUX_BIN) return process.env.TMUX_BIN;
  try {
    const p = execSync("command -v tmux", { encoding: "utf8", shell: "/bin/bash" }).trim();
    if (p) return p;
  } catch {}
  for (const p of ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"]) {
    if (fs.existsSync(p)) return p;
  }
  return "tmux";
}

// Default BIND to the Tailscale IP so we're only reachable over the tailnet.
function resolveBind() {
  if (process.env.BIND) return process.env.BIND;
  try {
    const ip = execSync("tailscale ip -4", { encoding: "utf8" }).trim().split("\n")[0];
    if (ip) return ip;
  } catch {}
  return "0.0.0.0";
}

const PORT = Number(process.env.PORT || 8765);
const BIND = resolveBind();
const SESSION_PREFIX = process.env.SESSION_PREFIX || "cc-"; // tmux session prefix
const CLAUDE_CMD = process.env.CLAUDE_CMD || "claude";
const DEFAULT_CWD = process.env.DEFAULT_CWD || os.homedir();
const TMUX_BIN = resolveTmuxBin();
// Optional password. If set, HTTP and WS both require the login cookie.
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";

// HMAC keyed by the password: cookies survive server restarts but rotating
// AUTH_PASSWORD invalidates every outstanding cookie.
const AUTH_COOKIE_NAME = "cr_auth";
const authToken = AUTH_PASSWORD
  ? crypto.createHmac("sha256", AUTH_PASSWORD).update("claude-remote").digest("hex")
  : "";

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}

function checkAuth(req) {
  if (!AUTH_PASSWORD) return true;
  const cookie = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];
  if (!cookie) return false;
  const a = Buffer.from(cookie, "utf8");
  const b = Buffer.from(authToken, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function checkPassword(password) {
  if (!AUTH_PASSWORD) return true;
  const a = Buffer.from(password || "", "utf8");
  const b = Buffer.from(AUTH_PASSWORD, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// CSRF defence: reject cross-origin POST/DELETE and cross-origin WS upgrades.
// Non-browser clients (curl, the WS test suite) don't send Origin and pass.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch { return false; }
}

// Keep control characters out of log lines so a crafted URL/UA can't forge
// log entries or break log-parsing downstream.
const stripCtl = (s) => String(s || "").replace(/[\r\n\x00-\x1f]/g, "?").slice(0, 200);

// Per-IP brute force limiter on /login. 5 failures -> 1 minute lockout.
const loginFailures = new Map();
function loginLockedOut(ip) {
  const rec = loginFailures.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { loginFailures.delete(ip); return false; }
  return rec.count >= 5;
}
function noteLoginFailure(ip) {
  const rec = loginFailures.get(ip) || { count: 0, until: 0 };
  rec.count++;
  rec.until = Date.now() + 60_000;
  loginFailures.set(ip, rec);
}

const LOGIN_PAGE = `<!doctype html>
<html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>claude-remote — sign in</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d10;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif}
  body{display:flex;align-items:center;justify-content:center}
  form{background:#15181d;border:1px solid #262a31;border-radius:12px;padding:22px;width:min(92vw,320px)}
  h1{margin:0 0 14px;font-size:16px;color:#d97757}
  input{width:100%;box-sizing:border-box;background:#0b0d10;color:#e6e6e6;border:1px solid #262a31;border-radius:8px;padding:12px;font-size:15px;margin-bottom:10px}
  button{width:100%;background:#d97757;color:#111;border:0;border-radius:8px;padding:12px;font-weight:600;font-size:15px}
  .err{color:#e05555;font-size:13px;margin:0 0 10px;min-height:1em}
</style></head>
<body><form method="POST" action="/login" autocomplete="on">
<h1>claude-remote</h1>
<p class="err">__ERR__</p>
<input type="password" name="password" placeholder="Password"
  autofocus autocomplete="current-password" />
<button type="submit">Sign in</button>
</form></body></html>`;

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
}

function listSessions() {
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

// ---------- HTTP ----------

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${stripCtl(req.url)} ua="${stripCtl(req.headers["user-agent"]).slice(0,60)}"`);
  next();
});

app.get("/login", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.status(200).send(LOGIN_PAGE.replace("__ERR__", ""));
});
app.post("/login", (req, res) => {
  const ip = req.socket.remoteAddress || "?";
  res.set("Cache-Control", "no-store");
  if (loginLockedOut(ip)) {
    return res.status(429).send(LOGIN_PAGE.replace("__ERR__", "Too many attempts — try again in a minute"));
  }
  const pw = (req.body && req.body.password) || "";
  if (!checkPassword(pw)) {
    noteLoginFailure(ip);
    return res.status(401).send(LOGIN_PAGE.replace("__ERR__", "Wrong password"));
  }
  loginFailures.delete(ip);
  res.set(
    "Set-Cookie",
    `${AUTH_COOKIE_NAME}=${authToken}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Strict`
  );
  res.redirect(302, "/");
});

// Auth gate. Browsers on HTML paths get redirected to /login; API/WS clients get JSON 401.
app.use((req, res, next) => {
  if (checkAuth(req)) return next();
  if (req.method === "GET" && (req.path === "/" || req.path.endsWith(".html"))) {
    return res.redirect(302, "/login");
  }
  res.status(401).json({ error: "auth required" });
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
  if (!sameOrigin(req)) return res.status(403).json({ error: "bad origin" });
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
  if (!sameOrigin(req)) return res.status(403).json({ error: "bad origin" });
  // killSession prepends SESSION_PREFIX, so only managed sessions can ever
  // be killed from this endpoint — arbitrary tmux sessions are safe.
  killSession(req.params.name);
  res.json({ ok: true });
});

// ---------- WebSocket ----------

const server = http.createServer(app);
// noServer mode so our auth check runs before ws writes the 101 response.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  console.log(`[ws] upgrade ${stripCtl(req.url)} from ${req.socket.remoteAddress}`);
  if (!sameOrigin(req) || !checkAuth(req)) {
    console.log(`[ws] upgrade denied`);
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://x");
  // /ws/<short> = managed session (we prepend SESSION_PREFIX).
  // /ws-raw/<rawname> = any tmux session by exact name, for viewing
  //   unmanaged sessions from the phone. Killable only via /ws (managed).
  const managedMatch = url.pathname.match(/^\/ws\/([a-zA-Z0-9_-]+)$/);
  const rawMatch = url.pathname.match(/^\/ws-raw\/([a-zA-Z0-9_.\-]+)$/);
  let rawName;
  if (managedMatch) rawName = SESSION_PREFIX + managedMatch[1];
  else if (rawMatch) rawName = decodeURIComponent(rawMatch[1]);
  else return ws.close(1008, "bad path");
  if (!sessionExists(rawName)) return ws.close(1008, "no such session");

  // Clamp client-reported terminal size so a malformed or huge resize can't
  // stress the pty. 500 is arbitrary but comfortably above any real screen.
  const clampSize = (n, dflt) => {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 1) return dflt;
    return Math.min(v, 500);
  };
  const cols = clampSize(url.searchParams.get("cols"), 100);
  const rows = clampSize(url.searchParams.get("rows"), 32);

  // Skip `-d` so multiple clients can co-watch. Strip TMUX env so tmux
  // won't refuse to nest if the server itself runs inside tmux.
  const childEnv = { ...process.env };
  delete childEnv.TMUX;
  delete childEnv.TMUX_PANE;
  let term;
  try {
    term = pty.spawn(
      TMUX_BIN,
      ["attach-session", "-t", rawName],
      { name: "xterm-256color", cols, rows, cwd: process.env.HOME, env: childEnv }
    );
  } catch (err) {
    console.error(`pty.spawn failed for ${rawName}:`, err.message);
    try { ws.send(`\r\n[claude-remote] failed to attach: ${err.message}\r\n`); } catch {}
    return ws.close(1011, "pty spawn failed");
  }

  term.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });
  term.onExit(() => {
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (msg) => {
    // Raw bytes, or a JSON control frame prefixed with \x01.
    const str = msg.toString();
    if (str.startsWith("\x01")) {
      try {
        const ctl = JSON.parse(str.slice(1));
        if (ctl.type === "resize") {
          term.resize(clampSize(ctl.cols, cols), clampSize(ctl.rows, rows));
        }
      } catch {}
      return;
    }
    term.write(str);
  });

  ws.on("close", () => {
    try { term.kill(); } catch {}
  });
});

server.listen(PORT, BIND, () => {
  console.log(`claude-remote listening on http://${BIND}:${PORT}`);
  console.log(`  session prefix: ${SESSION_PREFIX}`);
  console.log(`  default cwd:    ${DEFAULT_CWD}`);
  console.log(`  auth:           ${AUTH_PASSWORD ? "cookie (AUTH_PASSWORD set)" : "DISABLED"}`);
});
