import { useEffect, useState } from 'react'
import { AuthProvider, useAuth, makeCustomerToken } from './auth/AuthContext.jsx'
import { StoreContext, SimContext, useWorld } from './useStore.js'
import { store, sim, startRuntime } from './runtime.js'
import { fetchIncidents, INITIAL_INCIDENTS } from './services/on511.js'
import { fetchFlow, INITIAL_FLOW } from './services/tomtom.js'
import DispatchBoard from './views/DispatchBoard.jsx'
import DriverView from './views/DriverView.jsx'
import Dashboard from './views/Dashboard.jsx'
import CustomerView from './views/CustomerView.jsx'
import SignIn from './views/SignIn.jsx'
import { fmtTime } from './format.js'

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
  }, [])

  // A customer link is public by design: no sign-in, one load, less detail.
  if (hash.startsWith('#/t/')) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">Gladiolus <span>Corridor</span></div>
          <div className="spacer" />
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
          <Clock />
        </header>
        <SignIn />
      </div>
    )
  }

  const isDispatch = user.role === 'dispatch'
  const view = isDispatch ? (hash === '#/dashboard' ? 'dashboard' : 'board') : 'driver'

  function shareLink() {
    const truck = Object.values(store.getWorld().trucks).find((t) => t.laden)
    if (!truck) return
    const token = makeCustomerToken(truck.loadId, truck.id)
    go(`/t/${token}`)
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Gladiolus <span>Corridor</span></div>

        {isDispatch && (
          <nav className="nav">
            <button aria-current={view === 'board'} onClick={() => go('/board')}>Board</button>
            <button aria-current={view === 'dashboard'} onClick={() => go('/dashboard')}>Dashboard</button>
          </nav>
        )}

        <div className="spacer" />
        <Clock />
        <span className="clock feeds" title="Where the live layers are coming from">
          511 {feeds.incidents} · flow {feeds.flow}
        </span>
        {isDispatch && <button className="ghost" onClick={shareLink}>Customer link</button>}
        <button className="ghost" onClick={signOut}>
          Sign out<span className="wide-only"> — {user.name}</span>
        </button>
      </header>

      {view === 'board' && <DispatchBoard incidents={incidents} />}
      {view === 'dashboard' && <Dashboard />}
      {view === 'driver' && <DriverView />}
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
