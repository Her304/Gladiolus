import { useEffect, useState } from 'react'
import { AuthProvider, useAuth, makeCustomerToken, isStaff, isAdmin } from './auth/AuthContext.jsx'
import { StoreContext, SimContext, useWorld } from './useStore.js'
import { store, sim, startRuntime } from './runtime.js'
import { fetchIncidents, INITIAL_INCIDENTS } from './services/on511.js'
import { fetchFlow, INITIAL_FLOW } from './services/tomtom.js'
import DispatchBoard from './views/DispatchBoard.jsx'
import DetentionLedger from './views/DetentionLedger.jsx'
import DriverView, { DriverDemo, DriverSignIn } from './driver/DriverPortal.jsx'
import Dashboard from './views/Dashboard.jsx'
import CustomerView from './views/CustomerView.jsx'
import AdminConsole from './views/AdminConsole.jsx'
import SignIn from './views/SignIn.jsx'
import { fmtTime } from './format.js'
import { createServerClient } from './services/serverClient.js'
import { ConnectionBadge, attachServerClient } from './components/ConnectionBadge.jsx'

// One authoritative server client per session. Browsers are clients, not
// separate fleet worlds (plan §3.1): this connects to the shared SSE stream
// and falls back to the local sim, labelled, when no server is reachable.
const serverClient = createServerClient({ onEvent: (e) => store.append(e.type, e.observedAt ?? e.at, e) })
attachServerClient(serverClient)
serverClient.connect()

/** Hash routing, because the whole app is four screens and a shared link. */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return [hash, (h) => { window.location.hash = h }]
}

function Clock() {
  const world = useWorld()
  return <span className="clock">{fmtTime(world.clock)} simulated</span>
}

function Shell() {
  const { user, signOut } = useAuth()
  const [hash, go] = useHashRoute()
  const [incidents, setIncidents] = useState(INITIAL_INCIDENTS)
  const [feeds, setFeeds] = useState({ incidents: 'cached', flow: 'cached' })

  // Start the physical model once, then keep the live edge weights topped up.
  // Both services cache internally and fall back to a bundled fixture, so the
  // app is fully demoable with no network and no keys at all.
  useEffect(() => {
    startRuntime()
    sim.setIncidents(INITIAL_INCIDENTS)
    sim.setFlow(INITIAL_FLOW)

    let alive = true
    const pullIncidents = async () => {
      const res = await fetchIncidents()
      if (!alive) return
      setIncidents(res.data)
      setFeeds((f) => ({ ...f, incidents: res.source }))
      sim.setIncidents(res.data)
    }
    const pullFlow = async () => {
      const res = await fetchFlow()
      if (!alive) return
      setFeeds((f) => ({ ...f, flow: res.source }))
      sim.setFlow(res.data)
    }

    pullIncidents()
    pullFlow()
    const a = setInterval(pullIncidents, 5 * 60_000)
    const b = setInterval(pullFlow, 3 * 60_000)
    return () => { alive = false; clearInterval(a); clearInterval(b) }
  }, [store, sim])

  if (hash.startsWith('#/driver-demo')) return <DriverDemo />
  if (hash.startsWith('#/driver') && user?.role !== 'driver') return <DriverSignIn />

  // A customer link is public by design: no sign-in, one load, less detail.
  if (hash.startsWith('#/t/')) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">Gladiolus <span>Corridor</span></div>
          <div className="spacer" />
          <ConnectionBadge />
          <Clock />
        </header>
        <CustomerView token={hash.slice(4)} />
      </div>
    )
  }

  if (!user) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">Gladiolus <span>Corridor</span></div>
          <div className="spacer" />
          <ConnectionBadge />
          <Clock />
        </header>
        <SignIn />
      </div>
    )
  }

  const staff = isStaff(user)
  const admin = isAdmin(user)
  if (!staff) return <DriverView />

  // Routing is a fold over (role, hash) with the role winning, so a driver who
  // types #/admin lands on their own screen rather than a blank one.
  let view = 'driver'
  if (staff) {
    if (hash === '#/dashboard') view = 'dashboard'
    else if (hash === '#/detention') view = 'detention'
    else if (hash === '#/admin') view = admin ? 'admin' : 'board'
    else view = 'board'
  }

  function shareLink() {
    const truck = Object.values(store.getWorld().trucks).find((t) => t.laden)
    if (!truck) return
    const token = makeCustomerToken(truck.loadId, truck.id, truck.shipmentId)
    go(`/t/${token}`)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Gladiolus <span>Corridor</span></div>

        {staff && (
          <nav className="nav">
            <button aria-current={view === 'board'} onClick={() => go('/board')}>Board</button>
            <button aria-current={view === 'dashboard'} onClick={() => go('/dashboard')}>Dashboard</button>
            <button aria-current={view === 'detention'} onClick={() => go('/detention')}>Detention</button>
            {admin && (
              <button aria-current={view === 'admin'} onClick={() => go('/admin')}>Admin</button>
            )}
          </nav>
        )}

        <div className="spacer" />
        <ConnectionBadge />
        <Clock />
        <span className="clock feeds" title="Where the live layers are coming from">
          511 {feeds.incidents} · flow {feeds.flow}
        </span>
        {staff && <button className="ghost" onClick={shareLink}>Customer link</button>}
        <button className="ghost" onClick={signOut}>
          Sign out<span className="wide-only"> — {user.name}</span>
        </button>
      </header>

      {view === 'board' && <DispatchBoard incidents={incidents} />}
      {view === 'detention' && <DetentionLedger />}
      {view === 'dashboard' && <Dashboard />}
      {view === 'admin' && <AdminConsole feeds={feeds} />}
      {view === 'driver' && <DriverView incidents={incidents} />}
    </div>
  )
}

export default function App() {
  return (
    <StoreContext.Provider value={store}>
      <SimContext.Provider value={sim}>
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </SimContext.Provider>
    </StoreContext.Provider>
  )
}
