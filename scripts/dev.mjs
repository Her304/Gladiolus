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
import { spawn } from 'node:child_process'

const isWindows = process.platform === 'win32'
const npx = isWindows ? 'npx.cmd' : 'npx'

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
