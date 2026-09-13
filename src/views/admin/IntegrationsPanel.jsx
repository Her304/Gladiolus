import { useState } from 'react'
import { useWorld, useStore, useSim } from '../../useStore.js'
import { FLEET_SHARE } from '../../engine/parking.js'
import { DRIVE_LIMIT_MS, DUTY_LIMIT_MS, RESET_MS, H } from '../../engine/hos.js'
import { DWELL_THRESHOLD_MIN, APPROACH_KM } from '../../contract.js'
import { CORRIDOR } from '../../data/corridor.js'
import { logAdminAction, ACTION } from '../../admin/audit.js'
import { fmtTime, pct } from '../../format.js'
import { SERVER_ENABLED } from '../../services/serverConfig.js'

const SPEEDS = [1, 10, 30, 60, 120]

/**
 * External services are proxied through the server (Phase C): the browser never
 * holds an API key. This panel reports the feed status (live/cached) the
 * surfaces already track, and notes that keys are configured server-side. The
 * actual key presence is checked via /api/health or the integrations health
 * endpoint — not by reading VITE_ vars (which no longer exist).
 */
const SERVICES = [
  { name: 'TomTom flow', env: 'TOMTOM_KEY', proxy: '/api/traffic/flow', without: 'Cached flow sample' },
  { name: 'Anthropic LLM', env: 'LLM_KEY', proxy: '/api/llm/ask', without: 'Cached responses' },
  { name: 'Ontario 511', env: '(no key)', proxy: '/api/traffic/incidents', without: 'Bundled fixture' },
  { name: 'OSRM routing', env: 'OSRM_URL', proxy: '/api/route', without: 'Bundled 401 trace' },
]

export default function IntegrationsPanel({ user, feeds }) {
  const world = useWorld()
  const store = useStore()
  const sim = useSim()
  const [speed, setSpeed] = useState(() => sim?.getSpeed() ?? 1)

  function changeSpeed(n) {
    const before = speed
    sim?.setSpeed(n)
    setSpeed(n)
    if (n !== before) logAdminAction(user, ACTION.SIM_SPEED, `${before}× → ${n}×`)
  }

  return (
    <>
      <section className="card">
        <h3>Feeds</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Feed</th><th>Source right now</th><th>Cadence</th><th>Fallback</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>Ontario 511 incidents</td>
              <td><span className={`tag tag-${feeds.incidents === 'live' ? 'live' : 'cached'}`}>{feeds.incidents}</span></td>
              <td className="mono">5 min</td>
              <td>Bundled fixture</td>
            </tr>
            <tr>
              <td>TomTom corridor flow</td>
              <td><span className={`tag tag-${feeds.flow === 'live' ? 'live' : 'cached'}`}>{feeds.flow}</span></td>
              <td className="mono">3 min</td>
              <td>Bundled sample</td>
            </tr>
          </tbody>
        </table>
        <p className="note" style={{ paddingLeft: 0 }}>
          511 has no key. The shared Node server proxies it in development and
          production so provider CORS and rate limits never reach the browser.
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>External services (server-side keys)</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Service</th><th>Server env</th><th>Proxy</th><th>Without it</th></tr>
          </thead>
          <tbody>
            {SERVICES.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="mono">{s.env}</td>
                <td className="mono">{s.proxy}</td>
                <td>{s.without}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ paddingLeft: 0 }}>
          Keys live on the server and are never sent to the browser. The browser
          calls the proxy paths above; the server forwards to the provider with
          the server-side key. A missing key degrades to the cached fallback.
        </p>
      </section>

      {!SERVER_ENABLED && <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>Simulation</h3>
          <span className="note" style={{ padding: 0 }}>Speed</span>
          {SPEEDS.map((s) => (
            <button key={s} className="ghost" aria-current={speed === s} onClick={() => changeSpeed(s)}>{s}×</button>
          ))}
        </div>
        <div className="kv" style={{ marginTop: 10 }}>
          <span>Simulated clock</span><b className="mono">{fmtTime(world.clock)}</b>
          <span>Events appended</span><b className="mono">{store.events.length.toLocaleString('en-CA')}</b>
          <span>Trucks reporting</span><b className="mono">{Object.keys(world.trucks).length}</b>
          <span>Corridor length</span><b className="mono">{CORRIDOR.length.toFixed(1)} km</b>
        </div>
      </section>}

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Engine constants</h3>
        <div className="kv" style={{ marginTop: 8 }}>
          <span>Driving limit</span><b className="mono">{DRIVE_LIMIT_MS / H} h</b>
          <span>On-duty limit</span><b className="mono">{DUTY_LIMIT_MS / H} h</b>
          <span>Reset</span><b className="mono">{RESET_MS / H} h</b>
          <span>Fleet share of corridor traffic</span><b className="mono">{pct(FLEET_SHARE)}</b>
          <span>Dwell threshold</span><b className="mono">{DWELL_THRESHOLD_MIN} min</b>
          <span>Approach blend</span><b className="mono">{APPROACH_KM} km</b>
        </div>
        <p className="note" style={{ paddingLeft: 0 }}>
          Read-only, and deliberately so. These are frozen module constants that
          the engine and <span className="mono">scripts/smoke.mjs</span> both compile
          against — the smoke test asserts invariants in terms of them, so a value
          editable at runtime would be a value the merge gate no longer checks.
          Changing one is a code change and a re-run of the gate.
        </p>
      </section>
    </>
  )
}
