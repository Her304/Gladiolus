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

/** A customer link carries the load it may view. Encoded, not signed. */
export function makeCustomerToken(loadId, truckId) {
  return btoa(JSON.stringify({ loadId, truckId })).replace(/=+$/, '')
}

export function readCustomerToken(token) {
  try {
    const parsed = JSON.parse(atob(token))
    return parsed?.truckId ? parsed : null
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
