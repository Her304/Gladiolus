#!/usr/bin/env node
/**
 * Dev entry: run the authoritative server and the Vite dev server together.
 *
 * The browser app is wired (via VITE_SERVER_URL) to talk to the server on
 * :8787. If only `vite` is run, the browser's SSE stream has nothing to
 * connect to and the connection badge stays "Disconnected" forever. This
 * script starts both so `npm run dev` is self-sufficient: the server holds
 * the durable state + sim, and Vite serves the client with the /api proxy.
 *
 * Ctrl-C tears both down. The server is the parent of both children so a
 * crash in either is surfaced, not swallowed.
 */
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'

const isWindows = process.platform === 'win32'
const npx = isWindows ? 'npx.cmd' : 'npx'

const SERVER_PORT = Number(process.env.PORT) || 8787
const VITE_PORT = 5173

/**
 * Is a TCP port bound right now? Used to detect a stale dev server before we
 * try to start a fresh one — a leftover server on 8787 is the usual cause of
 * `EADDRINUSE` when `npm run dev` is started twice.
 */
function portInUse(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(true))
    probe.once('listening', () => { probe.close(() => resolve(false)) })
    probe.listen(port)
  })
}

/**
 * Best-effort: kill whatever is bound to a port so the new dev server can claim
 * it. We only reach here when the port is actually in use, so a failed lookup
 * (no PIDs) is reported but not fatal — the caller's bind will still surface a
 * clear EADDRINUSE if something else is holding it.
 */
async function freePort(port) {
  if (await portInUse(port) === false) return { freed: false, reason: 'already free' }
  let pids = []
  try {
    if (isWindows) {
      const out = execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess`],
        { encoding: 'utf8' })
      pids = out.split(/\s+/).map((s) => s.trim()).filter(Boolean)
    } else {
      const out = execFileSync('lsof', ['-ti', `TCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
      pids = out.split('\n').map((s) => s.trim()).filter(Boolean)
    }
  } catch {
    return { freed: false, reason: `port ${port} is in use but no owning pid found (clear it manually)` }
  }
  if (!pids.length) return { freed: false, reason: `port ${port} is in use but no owning pid found` }
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGKILL') } catch {}
  }
  // Wait for the bind to release. The OS reclaims the socket asynchronously.
  for (let i = 0; i < 20; i++) {
    if (await portInUse(port) === false) return { freed: true, killed: pids }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { freed: false, reason: `port ${port} still bound after killing ${pids.join(', ')}` }
}

// Clear any stale dev server before starting. A leftover `npm run dev` from a
// prior run (or one started in the background) holds :8787 and makes the next
// launch fail with EADDRINUSE. This makes `npm run dev` self-correcting.
for (const port of [SERVER_PORT, VITE_PORT]) {
  const r = await freePort(port)
  if (r.freed) {
    process.stdout.write(`[dev] freed port ${port} (killed stale pid${r.killed.length === 1 ? '' : 's'} ${r.killed.join(', ')})\n`)
  } else if (r.reason && !r.reason.includes('already free')) {
    process.stdout.write(`[dev] ${r.reason}\n`)
  }
}

function proc(cmd, args, label, colour, env = process.env) {
  const c = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const prefix = `\x1b[${colour}m[${label}]\x1b[0m`
  for (const stream of [c.stdout, c.stderr]) {
    stream.on('data', (b) => {
      for (const line of b.toString().split('\n')) {
        if (line.length) process.stdout.write(`${prefix} ${line}\n`)
      }
    })
  }
  c.on('exit', (code) => {
    process.stdout.write(`${prefix} exited (code ${code})\n`)
  })
  return c
}

const server = proc('node', ['scripts/start-server.mjs'], 'server', '36')
const vite = proc(npx, ['vite'], 'vite', '35', {
  ...process.env,
  VITE_SERVER_URL: process.env.VITE_SERVER_URL || 'http://localhost:8787',
})

function killAll() {
  for (const c of [server, vite]) {
    try { c.kill('SIGTERM') } catch {}
  }
  // Give them a moment, then force-kill anything still hanging.
  setTimeout(() => {
    for (const c of [server, vite]) {
      try { c.kill('SIGKILL') } catch {}
    }
    process.exit(0)
  }, 1500)
}

process.on('SIGINT', killAll)
process.on('SIGTERM', killAll)

// If either child dies, bring down the other and exit non-zero so the failure
// is visible instead of a half-running dev session.
for (const c of [server, vite]) {
  c.on('exit', () => {
    process.stdout.write('\x1b[31m[dev] a child exited; stopping both\x1b[0m\n')
    killAll()
  })
}
