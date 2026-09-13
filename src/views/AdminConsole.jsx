import { useState } from 'react'
import { useAuth } from '../auth/AuthContext.jsx'
import AccessPanel from './admin/AccessPanel.jsx'
import FleetPanel from './admin/FleetPanel.jsx'
import SitesPanel from './admin/SitesPanel.jsx'
import IntegrationsPanel from './admin/IntegrationsPanel.jsx'
import AuditPanel from './admin/AuditPanel.jsx'

const TABS = [
  { id: 'access', label: 'Access' },
  { id: 'fleet', label: 'Fleet' },
  { id: 'sites', label: 'Sites' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'audit', label: 'Audit' },
]

/**
 * The administrative surface — the fifth screen, above dispatch rather than
 * beside it.
 *
 * The line it draws: dispatch answers "what should this truck do in the next
 * hour", the console answers "what is this system configured to be". So nothing
 * here dispatches anything. It reads the directory, the registry and the log,
 * and it writes exactly one class of thing — corridor configuration — through
 * an audited path.
 */
export default function AdminConsole({ feeds }) {
  const { user } = useAuth()
  const [tab, setTab] = useState('access')

  return (
    <div className="page">
      <div className="admin-head">
        <div>
          <h1>Admin console</h1>
          <p className="note" style={{ padding: 0 }}>
            Configuration, directory and audit. Operational decisions stay on the board.
          </p>
        </div>
      </div>

      <div className="banner">
        <strong>Server-enforced administration.</strong> The signed session is
        validated on every protected API route. Hiding this route is only a UI
        convenience; authorization is enforced again beside the data it guards.
      </div>

      <div className="tabs" style={{ marginTop: 16 }}>
        {TABS.map((t) => (
          <button key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'access' && <AccessPanel user={user} />}
      {tab === 'fleet' && <FleetPanel />}
      {tab === 'sites' && <SitesPanel user={user} />}
      {tab === 'integrations' && <IntegrationsPanel user={user} feeds={feeds} />}
      {tab === 'audit' && <AuditPanel user={user} />}
    </div>
  )
}
