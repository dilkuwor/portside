import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const run = promisify(execFile);
const PORT = Number(process.env.PORT) || 80;
// Prefer loopback. macOS only lets non-root processes bind ports < 1024 on all
// interfaces, so for :80 we fall back to 0.0.0.0 and drop non-local connections.
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = `http://localhost${PORT === 80 ? "" : `:${PORT}`}`;
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");

// Paths that indicate an OS / desktop process rather than something you started in a terminal.
const SYSTEM_PREFIXES = ["/System/", "/usr/libexec/", "/usr/sbin/", "/Library/Apple/", "/Applications/", "/Library/"];

async function sh(cmd, args) {
  try {
    const { stdout } = await run(cmd, args, { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    // lsof exits 1 when nothing matches but still prints valid output
    return err.stdout || "";
  }
}

/** Parse `lsof -F` field output into records keyed by pid. */
function parseLsofFields(out, onFile) {
  let pid = null;
  let cmd = null;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    if (tag === "p") pid = Number(val);
    else if (tag === "c") cmd = val;
    else if (tag === "n" && pid != null) onFile(pid, cmd, val);
  }
}

function guessKind(command, name) {
  const s = `${name} ${command}`.toLowerCase();
  // Desktop apps (e.g. "Horizon Client Next.app") would otherwise match framework names
  if (/\.app\//.test(s) && !/python\.app\//.test(s)) return /docker/.test(s) ? "docker" : "app";
  const kinds = [
    ["antigravity", /\.gemini\/bin\/agy|antigravity|(^|[\s/])agy(\s|$)/],
    ["next", /\bnext\b|next-server/],
    ["vite", /\bvite\b/],
    ["nuxt", /\bnuxt\b/],
    ["astro", /\bastro\b/],
    ["remix", /\bremix\b/],
    ["webpack", /webpack/],
    ["bun", /\bbun\b/],
    ["deno", /\bdeno\b/],
    ["django", /manage\.py|django/],
    ["flask", /flask/],
    ["fastapi", /uvicorn|fastapi|hypercorn/],
    ["rails", /\brails\b|puma/],
    ["postgres", /postgres/],
    ["mysql", /mysqld/],
    ["redis", /redis/],
    ["mongo", /mongod/],
    ["docker", /docker|com\.docker|vpnkit/],
    ["java", /\bjava\b/],
    ["go", /\bgo-build|\/go\//],
    ["php", /\bphp\b/],
    ["ruby", /\bruby\b/],
    ["python", /python/],
    ["node", /\bnode\b|npm|pnpm|yarn/],
  ];
  for (const [k, re] of kinds) if (re.test(s)) return k;
  return "other";
}

/** ps etime "[[dd-]hh:]mm:ss" -> seconds */
function etimeToSec(e) {
  if (!e) return null;
  const [d, rest] = e.includes("-") ? e.split("-") : ["0", e];
  const t = rest.split(":").map(Number);
  while (t.length < 3) t.unshift(0);
  return Number(d) * 86400 + t[0] * 3600 + t[1] * 60 + t[2];
}

/** Human-friendly name for a parent process path ("/Applications/Visual Studio Code.app/..." -> "Visual Studio Code") */
function parentLabel(comm) {
  const app = comm.match(/\/([^/]+)\.app\//);
  return app ? app[1] : basename(comm);
}

/** Turn a full command line into a friendly display name. */
function friendlyName(command, fallback) {
  const parts = command.split(/\s+/).filter(Boolean);
  const exe = parts[0] ? basename(parts[0]) : fallback;
  if (exe === "agy") return "Antigravity";
  const appMatch = command.match(/\/([^/]+)\.app\//);
  if (appMatch && appMatch[1] !== "Python") return appMatch[1];
  const script = parts.slice(1).find((p) => !p.startsWith("-") && /[/.]/.test(p));
  if (/^(node|python\d*(\.\d+)?|ruby|bun|deno|php|java)$/i.test(exe)) {
    // e.g. "python3 -m http.server 8000" -> "http.server"
    const mod = parts.indexOf("-m");
    if (mod > 0 && parts[mod + 1]) return parts[mod + 1];
    // e.g. "node /path/to/project/node_modules/.bin/vite" -> "vite"
    const bin = script && script.match(/node_modules\/(?:\.bin\/)?(@[^/]+\/[^/]+|[^/]+)/);
    if (bin) return bin[1];
    if (script) return basename(script);
  }
  return exe || fallback;
}

async function listApps() {
  const lsofOut = await sh("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcnT"]);
  const byPid = new Map();

  parseLsofFields(lsofOut, (pid, cmd, addr) => {
    const m = addr.match(/^(.*):(\d+)$/);
    if (!m) return;
    const host = m[1].replace(/^\[|\]$/g, "");
    const port = Number(m[2]);
    if (!byPid.has(pid)) byPid.set(pid, { pid, shortName: cmd, ports: new Map() });
    const entry = byPid.get(pid).ports;
    if (!entry.has(port)) entry.set(port, new Set());
    entry.get(port).add(host);
  });

  if (byPid.size === 0) return [];
  const pids = [...byPid.keys()];

  // Full command, memory, cpu, elapsed time, user
  const psOut = await sh("ps", ["-o", "pid=,ppid=,rss=,%cpu=,etime=,user=,command=", "-p", pids.join(",")]);
  const psInfo = new Map();
  for (const line of psOut.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) psInfo.set(Number(m[1]), { ppid: Number(m[2]), rssKb: Number(m[3]), cpu: Number(m[4]), etime: m[5], user: m[6], command: m[7] });
  }

  // Parent processes ("who started this?" — a terminal, VS Code, launchd…)
  const ppids = [...new Set([...psInfo.values()].map((p) => p.ppid).filter((p) => p > 0))];
  const parents = new Map();
  if (ppids.length) {
    const parOut = await sh("ps", ["-o", "pid=,comm=", "-p", ppids.join(",")]);
    for (const line of parOut.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (m) parents.set(Number(m[1]), parentLabel(m[2]));
    }
  }

  // Working directory (tells you *which* project is running)
  const cwdOut = await sh("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"]);
  const cwds = new Map();
  parseLsofFields(cwdOut, (pid, _c, path) => cwds.set(pid, path));

  const apps = [];
  for (const [pid, info] of byPid) {
    const ps = psInfo.get(pid) || {};
    const command = ps.command || info.shortName;
    const cwd = cwds.get(pid) || null;
    const exePath = command.split(" ")[0];
    const ports = [...info.ports.entries()]
      .map(([port, hosts]) => ({
        port,
        hosts: [...hosts],
        // Our own socket refuses non-local connections, so it is effectively local-only
        public: pid !== process.pid && [...hosts].some((h) => h === "*" || h === "0.0.0.0" || h === "::"),
      }))
      .sort((a, b) => a.port - b.port);

    apps.push({
      pid,
      name: friendlyName(command, info.shortName),
      processName: info.shortName,
      command,
      cwd,
      project: cwd && cwd !== "/" ? basename(cwd) : null,
      kind: guessKind(command, info.shortName),
      system: SYSTEM_PREFIXES.some((p) => exePath.startsWith(p)),
      ports,
      memoryMb: ps.rssKb ? Math.round(ps.rssKb / 1024) : null,
      cpu: ps.cpu ?? null,
      uptime: ps.etime || null,
      uptimeSec: etimeToSec(ps.etime),
      ppid: ps.ppid ?? null,
      parent: ps.ppid === 1 ? "launchd" : parents.get(ps.ppid) || null,
      user: ps.user || null,
      self: pid === process.pid,
    });
  }
  return apps.sort((a, b) => a.ports[0].port - b.ports[0].port);
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Body too large");
  }
  return JSON.parse(raw || "{}");
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const LOCAL_ORIGINS = LOCAL_HOSTS.flatMap((h) => [`http://${h}:${PORT}`, ...(PORT === 80 ? [`http://${h}`] : [])]);

/** Block cross-site requests: only our own page may call the kill endpoint. */
function isSameOrigin(req) {
  const origin = req.headers.origin;
  return (!origin || LOCAL_ORIGINS.includes(origin)) && req.headers["content-type"]?.startsWith("application/json");
}

/** Reject requests addressed to any other hostname (DNS-rebinding protection). */
function isLocalHost(req) {
  const host = (req.headers.host || "").replace(/:\d+$/, "");
  return LOCAL_HOSTS.includes(host);
}

const isLoopback = (addr) => addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";

const server = http.createServer(async (req, res) => {
  if (!isLocalHost(req)) return send(res, 403, { error: "Forbidden host" });
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/apps") {
      return send(res, 200, {
        apps: await listApps(),
        selfPid: process.pid,
        at: Date.now(),
        machine: { hostname: os.hostname(), totalMemMb: Math.round(os.totalmem() / 1048576), cpus: os.cpus().length },
      });
    }

    if (req.method === "POST" && url.pathname === "/api/kill") {
      if (!isSameOrigin(req)) return send(res, 403, { error: "Forbidden" });
      const { pid, force } = await readJson(req);
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 1) return send(res, 400, { error: "Invalid PID" });
      if (n === process.pid) return send(res, 400, { error: "That's this dashboard — stop it from the terminal." });

      // Only allow killing processes that are actually listening on a port right now
      const apps = await listApps();
      if (!apps.some((a) => a.pid === n)) return send(res, 404, { error: "Process is no longer listening" });

      try {
        process.kill(n, force ? "SIGKILL" : "SIGTERM");
      } catch (err) {
        const msg = err.code === "EPERM" ? "Permission denied (process owned by another user)" : err.message;
        return send(res, 500, { error: msg });
      }
      return send(res, 200, { ok: true, pid: n, signal: force ? "SIGKILL" : "SIGTERM" });
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return send(res, 200, await readFile(join(PUBLIC_DIR, "index.html"), "utf8"), "text/html; charset=utf-8");
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

// Only this Mac may connect, even when bound to all interfaces
server.on("connection", (socket) => {
  if (!isLoopback(socket.remoteAddress)) socket.destroy();
});

function start(host) {
  server.once("error", (err) => {
    if (err.code === "EACCES" && host === "127.0.0.1") return start("0.0.0.0");
    if (err.code === "EADDRINUSE") console.error(`\n  Port ${PORT} is already in use. Try: PORT=4999 npm start\n`);
    else if (err.code === "EACCES") console.error(`\n  No permission to use port ${PORT}. Try: PORT=4999 npm start\n`);
    else console.error(err);
    process.exit(1);
  });
  server.listen(PORT, host);
}
server.once("listening", () => console.log(`\n  ⚓ Portside running at ${BASE_URL}\n`));
start(HOST);
