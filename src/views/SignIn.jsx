import { useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import { SEED_DRIVERS } from '../data/seed.js'

const DEMO_DRIVER = SEED_DRIVERS[0]

export default function SignIn() {
  const { signInDriver, signInDispatch } = useAuth()
  const [tab, setTab] = useState('dispatch')
  const [error, setError] = useState(null)

  function submit(e) {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const res =
      tab === 'driver'
        ? signInDriver(f.get('truckId'), f.get('pin'))
        : signInDispatch(f.get('email'), f.get('password'))
    setError(res.ok ? null : res.error)
  }

  return (
    <div className="page page-narrow">
      <div className="tabs">
        <button aria-pressed={tab === 'dispatch'} onClick={() => { setTab('dispatch'); setError(null) }}>
          Dispatch
        </button>
        <button aria-pressed={tab === 'driver'} onClick={() => { setTab('driver'); setError(null) }}>
          Driver
        </button>
      </div>

      <form className="form" onSubmit={submit} key={tab}>
        {tab === 'dispatch' ? (
          <>
            <label>
              Email
              <input name="email" type="email" defaultValue="dispatch@gladiolus.ca" autoComplete="off" />
            </label>
            <label>
              Password
              <input name="password" type="password" defaultValue="corridor" autoComplete="off" />
            </label>
          </>
        ) : (
          <>
            <label>
              Truck number
              <input name="truckId" defaultValue={DEMO_DRIVER.truckId} autoComplete="off" />
            </label>
            <label>
              PIN
              <input name="pin" inputMode="numeric" defaultValue={DEMO_DRIVER.pin} autoComplete="off" />
            </label>
          </>
        )}
        {error && <p className="err">{error}</p>}
        <button className="go" type="submit">Sign in</button>
      </form>

      <div className="banner" style={{ marginTop: 20 }}>
        <strong>Prototype auth.</strong> Credentials are seeded and compared in
        the browser against a list bundled into the app; the customer tracking
        link is encoded, not signed. That is a scoped decision for the
        prototype, not an oversight — none of it should survive contact with
        production.
      </div>
    </div>
  )
}
