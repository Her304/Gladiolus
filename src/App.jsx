import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { AuthProvider, useAuth, isStaff, isAdmin } from './auth/AuthContext.jsx'
import { StoreContext, SimContext, useWorld } from './useStore.js'
import { store, sim, startRuntime } from './runtime.js'
import { fetchIncidents, INITIAL_INCIDENTS } from './services/on511.js'
import { fetchFlow, INITIAL_FLOW } from './services/tomtom.js'
import SignIn from './views/SignIn.jsx'
import { fmtTime } from './format.js'
import { createServerClient } from './services/serverClient.js'
import { ConnectionBadge, attachServerClient } from './components/ConnectionBadge.jsx'
import { SERVER_ENABLED } from './services/serverConfig.js'

const DispatchBoard = lazy(() => import('./views/DispatchBoard.jsx'))
const DetentionLedger = lazy(() => import('./views/DetentionLedger.jsx'))
const ShipmentTimeline = lazy(() => import('./views/ShipmentTimeline.jsx'))
const DriverView = lazy(() => import('./driver/DriverPortal.jsx'))
const DriverDemo = lazy(() => import('./driver/DriverPortal.jsx').then((m) => ({ default: m.DriverDemo })))
const Dashboard = lazy(() => import('./views/Dashboard.jsx'))
const CustomerView = lazy(() => import('./views/CustomerView.jsx'))
const AdminConsole = lazy(() => import('./views/AdminConsole.jsx'))

function ViewLoader({ children }) {
  return <Suspense fallback={<div className="page"><div className="card">Loading operational view…</div></div>}>{children}</Suspense>
}

// One authoritative server client per session. Browsers are clients, not
// separate fleet worlds (plan §3.1): this connects to the shared SSE stream
// and falls back to the local sim, labelled, when no server is reachable.
const serverClient = createServerClient({
  onEvent: (e) => {
    store.append(e.type, e.observedAt ?? e.at, e)
    // SSE callbacks happen outside the simulator's batched tick.  Without this
    // commit React never observes the authoritative events it just received.
    store.commit()
  },
})
attachServerClient(serverClient)

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
  return <span className="clock">{world.clock ? fmtTime(world.clock) : 'Awaiting data'}{SERVER_ENABLED ? '' : ' simulated'}</span>
}

function Shell() {
  const { user, signOut } = useAuth()
  const [hash, go] = useHashRoute()
  const [incidents, setIncidents] = useState(INITIAL_INCIDENTS)
  const [feeds, setFeeds] = useState({ incidents: 'cached', flow: 'cached' })
  const customerToken = useMemo(() => hash.startsWith('#/t/') ? hash.slice(4) : null, [hash])

  // Select exactly one authoritative stream for this surface. A fresh public
  // tracking browser uses the grant from its URL; a staff/driver surface uses
  // the signed session token. Resetting on a scope change prevents a customer
  // view from inheriting fleet events previously visible to staff in this tab.
  useEffect(() => {
    if (customerToken) {
      store.reset()
      serverClient.reconnect(customerToken)
      return () => serverClient.disconnect()
    }
    if (user) {
      store.reset()
      serverClient.reconnect()
      return () => serverClient.disconnect()
    }
    serverClient.disconnect()
  }, [customerToken, user?.email])

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
  }, [store, sim, user?.email])

  if (hash.startsWith('#/driver-demo')) return <ViewLoader><DriverDemo /></ViewLoader>
  // The driver portal is reachable by any signed-in user on the same device —
  // a dispatcher can switch to the driver view and vice versa. The hash decides
  // the surface; the role only picks the default landing page.

  // A customer link is public by design: no sign-in, one shipment, less detail.
  if (hash.startsWith('#/t/')) return <ViewLoader><CustomerView token={hash.slice(4)} /></ViewLoader>

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

  // The driver portal (#/driver) is open to any signed-in user. This lets a
  // dispatcher try the driver experience on the same device without re-signing
  // in. A driver lands here by default; staff land on the board.
  if (hash.startsWith('#/driver')) return <ViewLoader><DriverView /></ViewLoader>

  // Routing is a fold over (role, hash). A driver with no hash lands on the
  // driver portal; staff land on the board. Either can navigate to the other.
  let view = 'driver'
  if (staff || hash.startsWith('#/')) {
    if (hash === '#/dashboard') view = 'dashboard'
    else if (hash === '#/detention') view = 'detention'
    else if (hash === '#/timeline') view = 'timeline'
    else if (hash === '#/admin') view = admin ? 'admin' : 'board'
    else view = staff ? 'board' : 'driver'
  }
  if (view === 'driver' && !hash.startsWith('#/driver')) return <ViewLoader><DriverView /></ViewLoader>

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Gladiolus <span>Corridor</span></div>

        <nav className="nav">
          <button aria-current={view === 'board'} onClick={() => go('/board')}>Board</button>
          <button aria-current={view === 'dashboard'} onClick={() => go('/dashboard')}>Dashboard</button>
          <button aria-current={view === 'detention'} onClick={() => go('/detention')}>Detention</button>
          <button aria-current={view === 'timeline'} onClick={() => go('/timeline')}>Timeline</button>
          {admin && (
            <button aria-current={view === 'admin'} onClick={() => go('/admin')}>Admin</button>
          )}
        </nav>

        <div className="spacer" />
        <ConnectionBadge />
        <Clock />
        <span className="clock feeds" title="Where the live layers are coming from">
          511 {feeds.incidents} · flow {feeds.flow}
        </span>
        <button className="ghost" onClick={signOut}>
          Sign out<span className="wide-only"> — {user.name}</span>
        </button>
      </header>

      <ViewLoader>
        {view === 'board' && <DispatchBoard incidents={incidents} />}
        {view === 'detention' && <DetentionLedger />}
        {view === 'timeline' && <ShipmentTimeline />}
        {view === 'dashboard' && <Dashboard />}
        {view === 'admin' && <AdminConsole feeds={feeds} />}
        {view === 'driver' && <DriverView incidents={incidents} />}
      </ViewLoader>
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
