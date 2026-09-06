import { useMemo, useState } from 'react'
import { SEED_USERS } from '../../data/seed.js'
import { logAdminAction, ACTION } from '../../admin/audit.js'

const ROLE_LABEL = { admin: 'Administrator', dispatch: 'Dispatcher', driver: 'Driver' }

/**
 * Accounts and roles. Read-only on purpose: the account list is a bundled
 * constant, so an "add user" button here could only write to a store that no
 * reload survives and no other device sees. Showing the real shape of the
 * seeded directory is more useful than a form that pretends.
 *
 * Revealing a seeded credential is itself an audited action — if the console
 * can show a PIN, the log should say who asked for it.
 */
export default function AccessPanel({ user }) {
  const [query, setQuery] = useState('')
  const [revealed, setRevealed] = useState(false)

  const staff = useMemo(() => SEED_USERS.filter((u) => u.role !== 'driver'), [])
  const drivers = useMemo(() => {
    const all = SEED_USERS.filter((u) => u.role === 'driver')
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (u) => u.name.toLowerCase().includes(q) || u.truckId.toLowerCase().includes(q),
    )
  }, [query])

  function toggleReveal() {
    const next = !revealed
    setRevealed(next)
    if (next) logAdminAction(user, ACTION.CREDENTIALS_REVEALED, `${SEED_USERS.length} seeded accounts`)
  }

  const mask = (s) => (revealed ? s : '•'.repeat(String(s).length))

  return (
    <>
      <section className="card">
        <h3>Signed in as</h3>
        <div className="kv">
          <span>Name</span><b>{user.name}</b>
          <span>Email</span><b className="mono">{user.email}</b>
          <span>Role</span><b><span className={`tag tag-${user.role}`}>{ROLE_LABEL[user.role]}</span></b>
          <span>Session</span><b className="mono">localStorage · corridor.session</b>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>Directory <span className="count">{SEED_USERS.length} accounts</span></h3>
          <button className="ghost" aria-current={revealed} onClick={toggleReveal}>
            {revealed ? 'Hide credentials' : 'Reveal credentials'}
          </button>
        </div>

        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Account</th><th>Name</th><th>Email</th><th>Role</th><th>Password</th></tr>
          </thead>
          <tbody>
            {staff.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.id}</td>
                <td>{u.name}</td>
                <td className="mono">{u.email}</td>
                <td><span className={`tag tag-${u.role}`}>{ROLE_LABEL[u.role]}</span></td>
                <td className="mono">{mask(u.password)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>Drivers <span className="count">{drivers.length} of 40</span></h3>
          <input
            className="field"
            placeholder="Filter by name or truck"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="scroll-y" style={{ marginTop: 8 }}>
          <table>
            <thead>
              <tr><th>Account</th><th>Driver</th><th>Truck</th><th>Driver ID</th><th className="num">PIN</th></tr>
            </thead>
            <tbody>
              {drivers.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.id}</td>
                  <td>{u.name}</td>
                  <td className="mono">{u.truckId}</td>
                  <td className="mono">{u.driverId}</td>
                  <td className="num">{mask(u.pin)}</td>
                </tr>
              ))}
              {drivers.length === 0 && (
                <tr><td colSpan={5}><span className="note" style={{ padding: 0 }}>No driver matches that.</span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="banner" style={{ marginTop: 16 }}>
        <strong>These are not credentials in any meaningful sense.</strong> PINs
        and passwords are plaintext in the bundle and compared in the browser,
        so this table shows what any visitor could already read out of the
        JavaScript. It is a directory view, not a secret. Role assignment,
        password rotation and account creation all need a server before they
        mean anything.
      </div>
    </>
  )
}
