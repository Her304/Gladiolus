import { useEffect, useMemo, useState } from 'react'
import { getToken } from '../../auth/AuthContext.jsx'
import { logAdminAction, ACTION } from '../../admin/audit.js'
import { SERVER_ENABLED, apiUrl } from '../../services/serverConfig.js'

const ROLE_LABEL = { admin: 'Administrator', dispatch: 'Dispatcher', driver: 'Driver' }

/**
 * Accounts and roles (Phase B). The directory is no longer a bundled constant
 * with plaintext passwords — it is fetched from the server's /api/users
 * endpoint (admin-only), which returns accounts WITHOUT password hashes. The
 * server is the authority; the browser is a read-only view of it.
 *
 * Passwords/PINs are no longer shown at all: the server holds them hashed, so
 * there is nothing to "reveal." Role assignment and account creation are server
 * commands, not client edits.
 */
export default function AccessPanel({ user }) {
  const [query, setQuery] = useState('')
  const [accounts, setAccounts] = useState([])
  const [source, setSource] = useState('loading')

  useEffect(() => {
    if (!SERVER_ENABLED) { setSource('local'); return }
    fetch(apiUrl('/api/users'), { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((r) => { if (r?.users) { setAccounts(r.users); setSource('live') } else setSource('error') })
      .catch(() => setSource('error'))
  }, [])

  const staff = useMemo(() => accounts.filter((u) => u.role !== 'driver'), [accounts])
  const drivers = useMemo(() => {
    const all = accounts.filter((u) => u.role === 'driver')
    const q = query.trim().toLowerCase()
    if (!q) return all
    return all.filter(
      (u) => (u.name || '').toLowerCase().includes(q) || (u.truckId || '').toLowerCase().includes(q),
    )
  }, [accounts, query])

  function refresh() {
    logAdminAction(user, ACTION.DIRECTORY_REFRESHED, `refreshed directory (${accounts.length} accounts)`)
    if (!SERVER_ENABLED) return
    fetch(apiUrl('/api/users'), { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((r) => { if (r?.users) setAccounts(r.users) })
      .catch(() => {})
  }

  return (
    <>
      <section className="card">
        <h3>Signed in as</h3>
        <div className="kv">
          <span>Name</span><b>{user.name}</b>
          <span>Email</span><b className="mono">{user.email}</b>
          <span>Role</span><b><span className={`tag tag-${user.role}`}>{ROLE_LABEL[user.role]}</span></b>
          <span>Session</span><b className="mono">signed server token · {source}</b>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>Directory <span className="count">{accounts.length} accounts</span></h3>
          <button className="ghost" onClick={refresh}>Refresh</button>
        </div>

        <table style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Account</th><th>Name</th><th>Email</th><th>Role</th></tr>
          </thead>
          <tbody>
            {staff.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.id}</td>
                <td>{u.name}</td>
                <td className="mono">{u.email}</td>
                <td><span className={`tag tag-${u.role}`}>{ROLE_LABEL[u.role]}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="row">
          <h3 style={{ flex: 1 }}>Drivers <span className="count">{drivers.length}</span></h3>
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
              <tr><th>Account</th><th>Driver</th><th>Truck</th><th>Driver ID</th></tr>
            </thead>
            <tbody>
              {drivers.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.id}</td>
                  <td>{u.name}</td>
                  <td className="mono">{u.truckId}</td>
                  <td className="mono">{u.driverId}</td>
                </tr>
              ))}
              {drivers.length === 0 && (
                <tr><td colSpan={4}><span className="note" style={{ padding: 0 }}>
                  {source === 'local' ? 'No server connected — sign in to load the directory.' : 'No driver matches that.'}
                </span></td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="banner" style={{ marginTop: 16 }}>
        <strong>Passwords are hashed on the server.</strong> This directory is
        read from the server's account table; credentials are never sent to the
        browser. Role assignment and account creation are server commands.
      </div>
    </>
  )
}
