import { useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import { SEED_DRIVERS } from '../data/seed.js'

const DEV = import.meta.env?.DEV
const DEMO_DRIVER = SEED_DRIVERS[0]
// Vite removes this development-only credential from production builds. The
// full driver credential directory lives exclusively in server/seed-users.js.
const DEV_DRIVER_PIN = DEV ? '8101' : ''

export default function SignIn() {
  const { signInDriver, signInDispatch, signInAdmin } = useAuth()
  const [tab, setTab] = useState('dispatch')
  const [error, setError] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    let res
    try {
      if (tab === 'driver') res = await signInDriver(f.get('truckId'), f.get('pin'))
      else if (tab === 'admin') res = await signInAdmin(f.get('email'), f.get('password'))
      else res = await signInDispatch(f.get('email'), f.get('password'))
    } catch {
      res = { ok: false, error: 'Could not reach the server.' }
    }
    setError(res.ok ? null : res.error)
  }

  return (
    <div className="page page-narrow">
      <a href="#/driver-demo/today" className="ghost" style={{ display: 'block', marginBottom: 20 }}>Try the loading / unloading driver simulation →</a>
      <div className="tabs">
        <button aria-pressed={tab === 'dispatch'} onClick={() => { setTab('dispatch'); setError(null) }}>
          Dispatch
        </button>
        <button aria-pressed={tab === 'driver'} onClick={() => { setTab('driver'); setError(null) }}>
          Driver
        </button>
        <button aria-pressed={tab === 'admin'} onClick={() => { setTab('admin'); setError(null) }}>
          Admin
        </button>
      </div>

      <form className="form" onSubmit={submit} key={tab}>
        {tab !== 'driver' ? (
          <>
            <label>
              Email
              <input
                name="email"
                type="email"
                defaultValue={DEV ? (tab === 'admin' ? 'admin@gladiolus.ca' : 'dispatch@gladiolus.ca') : ''}
                autoComplete="off"
              />
            </label>
            <label>
              Password
              <input name="password" type="password" defaultValue={DEV ? 'corridor' : ''} autoComplete="off" />
            </label>
          </>
        ) : (
          <>
            <label>
              Truck number
              <input name="truckId" defaultValue={DEV ? DEMO_DRIVER.truckId : ''} autoComplete="off" />
            </label>
            <label>
              PIN
              <input name="pin" type="password" inputMode="numeric" defaultValue={DEV_DRIVER_PIN} autoComplete="current-password" />
            </label>
          </>
        )}
        {error && <p className="err">{error}</p>}
        <button className="go" type="submit">Sign in</button>
      </form>

      <div className="banner" style={{ marginTop: 20 }}>
        <strong>Server-enforced access.</strong> Passwords are hashed at rest;
        client tracking links are signed, expiring, revocable, and scoped to
        one shipment.
      </div>
    </div>
  )
}
