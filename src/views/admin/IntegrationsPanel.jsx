import { useState } from 'react'
import { useWorld, useStore, useSim } from '../../useStore.js'
import { FLEET_SHARE } from '../../engine/parking.js'
import { DRIVE_LIMIT_MS, DUTY_LIMIT_MS, RESET_MS, H } from '../../engine/hos.js'
import { DWELL_THRESHOLD_MIN, APPROACH_KM } from '../../contract.js'
import { CORRIDOR } from '../../data/corridor.js'
import { logAdminAction, ACTION } from '../../admin/audit.js'
import { fmtTime, pct } from '../../format.js'

const SPEEDS = [10, 30, 60, 120]

/**
 * Keys are reported present or absent and never printed. That distinction is
 * not theatre: `VITE_` variables are inlined into the bundle at build time, so
 * anything the console could display, a visitor could already read — but a
 * console that renders a key onto a demo-room projector adds a way to leak it
 * that reading the bundle does not.
 */
const KEYS = [
  { name: 'VITE_TOMTOM_KEY', service: 'TomTom flow', present: Boolean(import.meta.env?.VITE_TOMTOM_KEY), without: 'Cached flow sample' },
  { name: 'VITE_LLM_KEY', service: 'Anthropic', present: Boolean(import.meta.env?.VITE_LLM_KEY), without: 'Cached responses' },
  { name: 'VITE_ROUTING_KEY', service: 'Predictive ETA', present: Boolean(import.meta.env?.VITE_ROUTING_KEY), without: 'Unused today' },
]

export default function IntegrationsPanel({ user, feeds }) {
  const world = useWorld()
  const store = useStore()
  const sim = useSim()
  const [speed, setSpeed] = useState(() => sim?.getSpeed() ?? 30)

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
          511 has no key and is proxied through Vite in development because it
          does not reliably send CORS headers. A static production build has no
          such proxy and will read <span className="mono">cached</span> here until a
          function sits in front of it.
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h3>Keys</h3>
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Variable</th><th>Service</th><th>Status</th><th>Without it</th></tr>
          </thead>
          <tbody>
            {KEYS.map((k) => (
              <tr key={k.name}>
                <td className="mono">{k.name}</td>
                <td>{k.service}</td>
                <td><span className={`tag tag-${k.present ? 'live' : 'absent'}`}>{k.present ? 'configured' : 'not set'}</span></td>
                <td>{k.without}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note" style={{ paddingLeft: 0 }}>
          Presence only — values are never rendered. Every one of these is
          inlined into the client bundle at build time, which is acceptable for a
          throwaway demo key and wrong for anything else.
        </p>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
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
      </section>

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
