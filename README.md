# Portside

A local admin dashboard that shows every app listening on a port on your Mac — and lets you stop it.

## Features

- **Overview** — running apps, open ports, memory/CPU, memory-over-time chart, top memory users, and a "needs attention" panel (ports exposed to your network, heavy processes, forgotten dev servers)
- **Applications** — sortable table with project folder, ports, PID, type (Next.js, Vite, Python, Antigravity…), parent process, uptime, memory and CPU; bulk select & stop
- **Ports** — every listening port with its bind address and Local / Network exposure
- **Activity** — log of apps starting, stopping and being killed
- Details drawer with full command and working directory
- Graceful stop (`SIGTERM`) or force kill (`SIGKILL`) with confirmation
- Light / dark theme, collapsible sidebar, keyboard shortcuts

## Run

```bash
npm start
```

Then open http://localhost. No dependencies — just Node.js 18+ and macOS (`lsof`, `ps`).

Use a different port with `PORT=4999 npm start` (e.g. if something else already uses port 80).

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `/` | Search |
| `1`–`4` | Switch page |
| `R` | Refresh |
| `T` | Toggle theme |
| `[` | Collapse sidebar |
| `Esc` | Close panel / clear selection |

## Security

Only connections from this Mac are accepted. macOS doesn't let normal users bind port 80 on `127.0.0.1`, so on port 80 the server listens on all interfaces and immediately drops any connection that isn't from loopback (on other ports it binds `127.0.0.1` directly). Requests for any hostname other than `localhost` / `127.0.0.1` are rejected to prevent DNS rebinding. The kill endpoint rejects cross-origin requests and only signals processes that are currently listening on a port.
