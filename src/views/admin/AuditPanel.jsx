import { useMemo, useState } from 'react'
import { useWorld, useStore } from '../../useStore.js'
import { EVENT } from '../../contract.js'
import { logAdminAction, ACTION } from '../../admin/audit.js'
import { fmtTime } from '../../format.js'

/** How many raw events the inspector renders. The log itself is unbounded. */
const WINDOW = 200

export default function AuditPanel({ user }) {
  const world = useWorld()
  const store = useStore()
  const [type, setType] = useState('all')

  // Counting types walks the whole log, which is tens of thousands of pings an
  // hour, so it recomputes once per appended event rather than once per render.
  const counts = useMemo(() => {
    const out = new Map()
    for (const e of store.events) out.set(e.type, (out.get(e.type) || 0) + 1)
    return [...out.entries()].sort((a, b) => b[1] - a[1])
  }, [world.lastEventSeq, store])

  const recent = useMemo(() => {
    const out = []
    for (let i = store.events.length - 1; i >= 0 && out.length < WINDOW; i--) {
      const e = store.events[i]
      if (type === 'all' || e.type === type) out.push(e)
    }
    return out
  }, [world.lastEventSeq, store, type])

  const trail = useMemo(() => [...world.adminLog].reverse(), [world.adminLog])

  function exportLog() {
    const slice = type === 'all' ? store.events : store.events.filter((e) => e.type === type)
    const blob = new Blob([JSON.stringify(slice, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `corridor-log-${type === 'all' ? 'full' : type.replace(/\./g, '-')}.json`
    a.click()
    URL.revokeObjectURL(url)
    logAdminAction(user, ACTION.LOG_EXPORTED, `${slice.length.toLocaleString('en-CA')} events (${type})`)
  }

  return (
    <>
      <section className="card">
        <h3>Administrator actions <span className="count">{trail.length}</span></h3>
        {trail.length === 0 && (
          <p className="note" style={{ paddingLeft: 0 }}>
            Nothing yet. Change a site capacity or the simulation speed and it
            lands here, in the dispatcher's feed, and in the log itself.
          </p>
        )}
        {trail.length > 0 && (
          <div className="scroll-y" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th className="num">Seq</th><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th></tr>
              </thead>
              <tbody>
                {trail.map((a) => (
                  <tr key={a.seq}>
                    <td className="num">{a.seq}</td>
                    <td className="mono">{fmtTime(a.at)}</td>
                    <td className="mono">{a.actor}</td>
                    <td>{a.action}</td>
                    <td className="muted">{a.detail ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>
            Log inspector <span className="count">{store.events.length.toLocaleString('en-CA')} events</span>
          </h3>
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All types</option>
            {counts.map(([t, n]) => (
              <option key={t} value={t}>{t} ({n.toLocaleString('en-CA')})</option>
            ))}
          </select>
          <button className="ghost" onClick={exportLog}>Export JSON</button>
        </div>

        <div className="scroll-y tall" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr><th className="num">Seq</th><th>Time</th><th>Type</th><th>Subject</th><th>Payload</th></tr>
            </thead>
            <tbody>
              {recent.map((e) => {
                const { seq, at, type: t, truckId, actor, ...rest } = e
                return (
                  <tr key={seq} className={t === EVENT.FORCED_STOP ? 'alarm' : undefined}>
                    <td className="num">{seq}</td>
                    <td className="mono">{fmtTime(at)}</td>
                    <td className="mono">{t}</td>
                    <td className="mono">{truckId || actor || '—'}</td>
                    <td className="mono muted clip">
                      {t === EVENT.PING ? '{ truck: … }' : JSON.stringify(rest)}
                    </td>
                  </tr>
                )
              })}
              {recent.length === 0 && (
                <tr><td colSpan={5}><span className="note" style={{ padding: 0 }}>No events of that type yet.</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="note" style={{ paddingLeft: 0 }}>
          Newest first, capped at {WINDOW} rows for render cost — the export is
          not capped. Ping payloads are elided because a full truck snapshot per
          row is unreadable; the export carries them in full.
        </p>
      </section>

      <div className="banner" style={{ marginTop: 16 }}>
        <strong>This log is in memory only.</strong> It starts empty on every
        reload and is never written anywhere, so the audit trail above survives
        exactly as long as the tab does. An audit trail the administrator being
        audited can clear by pressing F5 is a demonstration of the shape, not a
        control.
      </div>
    </>
  )
}
