import { useMemo, useState } from 'react'
import MapPane from '../components/MapPane.jsx'
import ParkingPanel from '../components/ParkingPanel.jsx'
import EventFeed from '../components/EventFeed.jsx'
import DispatchWorkflow from '../components/DispatchWorkflow.jsx'
import { useWorld, useFeed, useSim, useEvents } from '../useStore.js'
import { pressureBoard, recommendParking } from '../engine/parking.js'
import { hosStatus, clockLeftMs, fmtClock } from '../engine/hos.js'
import { ask, summariseBoard } from '../services/llm.js'
import { issueCommand } from '../services/serverApi.js'

const SPEEDS = [10, 30, 60, 120]
const INCIDENT_ROWS = 8

export default function DispatchBoard({ incidents }) {
  const world = useWorld()
  const feed = useFeed(40)
  const sim = useSim()
  const events = useEvents()
  const [focusId, setFocusId] = useState(null)
  const [speed, setSpeed] = useState(() => sim?.getSpeed() ?? 30)
  const [answer, setAnswer] = useState(null)
  const [asking, setAsking] = useState(false)

  const now = useMemo(() => new Date(world.clock), [world.clock])
  const board = useMemo(() => pressureBoard(world, now), [world, now])

  /** Trucks that need a decision from a human in the next hour or so. */
  const alerts = useMemo(() => {
    const out = []
    for (const t of Object.values(world.trucks)) {
      if (t.parked) continue
      const status = hosStatus(t)
      if (status !== 'critical' && status !== 'violation') continue
      const rec = recommendParking(t, world, now)
      out.push({ truck: t, status, rec })
    }
    return out.sort((a, b) => clockLeftMs(a.truck) - clockLeftMs(b.truck)).slice(0, 6)
  }, [world, now])

  async function askBoard() {
    setAsking(true)
    const res = await ask(
      'query',
      `You are a fleet dispatcher's assistant on the Highway 401 corridor.\n` +
        `${summariseBoard(world, board)}\n\n` +
        `Which trucks are at risk of running out of hours before they reach a rest ` +
        `area with space, and what would you do about each one? Be specific and brief.`,
    )
    setAnswer(res)
    setAsking(false)
  }

  /** Reply to a driver's request. Threads under the original by seq so the
   *  driver's "Your requests" view can nest it. */
  async function replyTo(seq, truckId, message) {
    const result = await issueCommand({ type: 'replyDriver', truckId, replyTo: seq, message })
    if (!result.ok) console.error(result.error || 'Unable to reply to driver')
  }

  const focusCoord = focusId ? world.trucks[focusId]?.coord : null

  return (
    <div className="board">
      <DispatchWorkflow events={events} world={world} incidents={incidents} onFocusTruck={setFocusId} />
      <MapPane
        world={world}
        events={events}
        incidents={incidents}
        board={board}
        focusId={focusId}
        focusCoord={focusCoord}
        onSelectTruck={setFocusId}
      />

      <aside className="rail">
        <section className="panel">
          <h2>
            Fleet <span className="count">{Object.keys(world.trucks).length} trucks</span>
          </h2>
          <div style={{ padding: '0 14px 12px', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="note" style={{ padding: 0 }}>Sim speed</span>
            {SPEEDS.map((s) => (
              <button
                key={s}
                className="ghost"
                aria-current={speed === s}
                onClick={() => { sim?.setSpeed(s); setSpeed(s) }}
              >
                {s}×
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Needs a decision <span className="count">{alerts.length}</span></h2>
          {alerts.length === 0 && (
            <p className="note">No driver is inside 30 minutes of their limit.</p>
          )}
          {alerts.map(({ truck, status, rec }) => (
            <div key={truck.id} className="lot" style={{ display: 'block' }}>
              <div className="lot-name">
                {truck.id}{' '}
                <span className={`hos hos-${status}`}>{fmtClock(clockLeftMs(truck))} left</span>
              </div>
              <div className="lot-sub" style={{ whiteSpace: 'normal' }}>
                {rec
                  ? `${rec.viable ? 'Send to' : 'Only option'} ${rec.best.site.name}, ` +
                    `${Math.round(rec.best.ahead)} km ahead, ${rec.best.projectedFree} projected free`
                  : `Nothing reachable — nearest lot is beyond the remaining clock`}
              </div>
            </div>
          ))}
        </section>

        <ParkingPanel board={board} />

        <section className="panel">
          <h2>Ask the board</h2>
          <div style={{ padding: '0 14px 12px' }}>
            <button className="ghost" onClick={askBoard} disabled={asking}>
              {asking ? 'Thinking…' : 'Who is at risk tonight?'}
            </button>
            {answer && (
              <>
                <p className="prose" style={{ fontSize: 13, marginTop: 10 }}>{answer.text}</p>
                <p className="note" style={{ padding: 0 }}>
                  {answer.source === 'live' ? 'Live model response.' : 'Cached response — no API key configured.'}
                </p>
              </>
            )}
          </div>
        </section>

        <EventFeed events={feed} onReply={replyTo} />

        <section className="panel">
          <h2>Road conditions <span className="count">{incidents.length}</span></h2>
          {/*
            Every incident still feeds speedFactorAt; the cap is display only.
            A live corridor pull is ~49 entries, which buries the rest of the
            board on a phone. Full closures first — they are the ones that
            change a dispatcher's mind.
          */}
          {[...incidents]
            .sort((a, b) => Number(b.fullClosure) - Number(a.fullClosure))
            .slice(0, INCIDENT_ROWS)
            .map((i) => (
              <div key={i.id} className="lot" style={{ display: 'block' }}>
                <div className="lot-name">{i.road} — {i.direction}</div>
                <div className="lot-sub" style={{ whiteSpace: 'normal' }}>{i.description}</div>
              </div>
            ))}
          {incidents.length > INCIDENT_ROWS && (
            <div className="lot-sub">+{incidents.length - INCIDENT_ROWS} more on the corridor</div>
          )}
        </section>
      </aside>
    </div>
  )
}
