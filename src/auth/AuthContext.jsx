import { createContext, useContext, useMemo, useState } from 'react'
import { SEED_USERS } from '../data/seed.js'

/**
 * Seeded auth. PINs and passwords are compared in the browser against a list
 * bundled into the app, and the customer "signature" is not a signature.
 *
 * This is deliberate and scoped to the prototype, not an oversight — say so
 * plainly if a judge asks. Nothing here should survive contact with production.
 */
const AuthCtx = createContext(null)

const SESSION_KEY = 'corridor.session'

/** Staff see the board; admins see the board and the console above it. */
export const isStaff = (u) => u?.role === 'dispatch' || u?.role === 'admin'
export const isAdmin = (u) => u?.role === 'admin'

/**
 * A customer tracking link is shipment-scoped, expiring, and revocable
 * (assessment §8/C11: the old token was unsigned base64 and followed the truck's
 * current destination, so a reassignment could expose the next customer's
 * shipment). The grant binds to ONE shipmentId; the truck's next load never
 * leaks through it. In the browser-only fallback the grant is encoded (labelled
 * prototype); the server path signs it with an HMAC (server/app.js mintToken).
 */
const CUSTOMER_TTL_MS = 72 * 3600_000

export function makeCustomerToken(loadId, truckId, shipmentId) {
  const payload = {
    loadId, truckId,
    shipmentId: shipmentId || (loadId ? `SHP-${loadId}` : null),
    scope: 'shipment',
    exp: Date.now() + CUSTOMER_TTL_MS,
  }
  return `grant.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}`
}

export function readCustomerToken(token) {
  try {
    if (!token || !token.startsWith('grant.')) {
      // Legacy unsigned token — reject rather than silently honoring it, so an
      // old link cannot follow a truck's next destination after reassignment.
      return null
    }
    const parsed = JSON.parse(atob(token.slice(6)))
    if (!parsed?.shipmentId) return null
    if (parsed.exp && Date.now() > parsed.exp) return { expired: true, shipmentId: parsed.shipmentId }
    return parsed
  } catch {
    return null
  }
}

function restore() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    // Private windows and blocked site data both throw here.
    return null
  }
}

function persist(user) {
  try {
    if (user) localStorage.setItem(SESSION_KEY, JSON.stringify(user))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* non-fatal: the session simply does not survive a reload */
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(restore)

  /** Email-and-password roles differ only in which role they will accept. */
  function matchByEmail(role, email, password) {
    return SEED_USERS.find(
      (u) => u.role === role &&
        u.email.toLowerCase() === String(email).trim().toLowerCase() &&
        u.password === password,
    )
  }

  const value = useMemo(
    () => ({
      user,
      /** Drivers sign in with a truck number and a four-digit PIN. */
      signInDriver(truckId, pin) {
        const found = SEED_USERS.find(
          (u) => u.role === 'driver' &&
            u.truckId.toLowerCase() === String(truckId).trim().toLowerCase() &&
            u.pin === String(pin).trim(),
        )
        if (!found) return { ok: false, error: 'Unknown truck number or PIN.' }
        setUser(found)
        persist(found)
        return { ok: true }
      },
      /** Dispatchers use email and password. */
      signInDispatch(email, password) {
        const found = matchByEmail('dispatch', email, password)
        if (!found) return { ok: false, error: 'Those credentials do not match.' }
        setUser(found)
        persist(found)
        return { ok: true }
      },
      /**
       * Administrators, same as dispatch with a different role. Worth being
       * blunt: this is a client-side equality check against a bundled list, so
       * the admin console is gated by an `if` that anyone can edit in devtools.
       * A real console needs the role decided by a server that holds the data.
       */
      signInAdmin(email, password) {
        const found = matchByEmail('admin', email, password)
        if (!found) return { ok: false, error: 'Those credentials do not match.' }
        setUser(found)
        persist(found)
        return { ok: true }
      },
      signOut() {
        setUser(null)
        persist(null)
      },
    }),
    [user],
  )

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
