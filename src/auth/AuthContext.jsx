import { createContext, useContext, useMemo, useState, useEffect } from 'react'
import { SERVER_ENABLED, apiUrl } from '../services/serverConfig.js'

/**
 * Server-enforced auth (Phase B).
 *
 * Sign-in is no longer a browser-side comparison against a bundled SEED_USERS
 * list with plaintext passwords. It calls POST /api/auth/login; the server
 * verifies the scrypt-hashed password and returns a signed HMAC token. The
 * token is stored (not the user object) and the user is derived from
 * GET /api/session. SEED_USERS is no longer imported into the browser bundle.
 *
 * Customer tracking links are signed server-side too: POST /api/tracking/:ship
 * mints a shipment-scoped grant. readCustomerToken stays here as a display-only
 * reader (it decodes the payload for the customer view; the server validates the
 * signature on the stream).
 */
const AuthCtx = createContext(null)

const TOKEN_KEY = 'corridor.token'
/** Staff see the board; admins see the board and the console above it. */
export const isStaff = (u) => u?.role === 'dispatch' || u?.role === 'admin'
export const isAdmin = (u) => u?.role === 'admin'

/** The stored signed token (for command/stream requests). */
export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

/**
 * Read a customer tracking grant's payload for DISPLAY ONLY. The server
 * validates the signature; this just decodes it so the customer view can show
 * the shipment id. A missing/expired grant reads as null/expired.
 */
export function readCustomerToken(token) {
  try {
    if (!token || !token.includes('.')) return null
    const [b64] = token.split('.')
    const padded = b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')
    const parsed = JSON.parse(atob(padded))
    if (!parsed?.shipmentId) return null
    if (parsed.exp && Date.now() > parsed.exp) return { expired: true, shipmentId: parsed.shipmentId }
    return parsed
  } catch {
    return null
  }
}

/**
 * Mint a customer tracking link via the server (dispatch/admin only). The
 * browser never signs; the server returns the signed, shipment-scoped grant.
 */
export async function makeCustomerToken(shipmentId) {
  const res = await fetch(apiUrl(`/api/tracking/${encodeURIComponent(shipmentId)}`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
  })
  const r = await res.json()
  return r.ok ? r.token : null
}

function restoreToken() {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

export function AuthProvider({ children, onAuthenticated }) {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)

  // On mount, if a token is stored, validate it against the server to restore
  // the session. In dev with no server, this no-ops (user stays null → sign-in).
  useEffect(() => {
    const token = restoreToken()
    if (!token || !SERVER_ENABLED) { setReady(true); return }
    fetch(apiUrl('/api/session'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.ok ? r.json() : null)
      .then((r) => { if (r?.user) { setUser(r.user); onAuthenticated?.() } })
      .catch(() => {})
      .finally(() => setReady(true))
  }, [])

  async function login(email, password) {
    if (!SERVER_ENABLED) return { ok: false, error: 'Start the shared server to sign in.' }
    const res = await fetch(apiUrl('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const r = await res.json()
    if (!r.ok) return { ok: false, error: r.error || 'Login failed.' }
    try { localStorage.setItem(TOKEN_KEY, r.token) } catch { /* non-fatal */ }
    setUser(r.user)
    // Reconnect the SSE stream now that a token exists.
    onAuthenticated?.()
    return { ok: true }
  }

  const value = useMemo(
    () => ({
      user,
      ready,
      /** Drivers sign in with truck number + PIN (mapped to an email-shaped
       *  account at seed time: <truckId>@carrier.local). */
      async signInDriver(truckId, pin) {
        return login(`${String(truckId).trim().toLowerCase()}@carrier.local`, String(pin).trim())
      },
      async signInDispatch(email, password) { return login(email, password) },
      async signInAdmin(email, password) { return login(email, password) },
      signOut() {
        try { localStorage.removeItem(TOKEN_KEY) } catch { /* non-fatal */ }
        setUser(null)
      },
    }),
    [user, ready],
  )

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
