/**
 * Server-enforced authentication (Phase B).
 *
 * Replaces the browser-seeded plaintext auth (SEED_USERS compared client-side)
 * with server-side password hashing (node:crypto scrypt — no bcrypt dep), a
 * users table, and login/session endpoints. The plaintext seed is used only
 * once, on first boot, to populate the users table with hashed passwords; after
 * that the table is the authority and the seed leaves the browser bundle.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'

/** scrypt parameters — production-grade but not over-tuned for a pilot. */
const SCRYPT_KEYLEN = 64
const SCRYPT_N = 16384

/** Promisified scrypt. */
function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived)
    })
  })
}

/**
 * Hash a password: returns `scrypt:N:saltHex:hashHex`. The salt is random per
 * password; the format is self-describing so verifyPassword can evolve.
 */
export async function hashPassword(plain) {
  const salt = randomBytes(16)
  const derived = await scrypt(String(plain), salt)
  return `scrypt:${SCRYPT_N}:${salt.toString('hex')}:${derived.toString('hex')}`
}

/**
 * Verify a password against a stored `scrypt:N:salt:hash` string. Constant-time
 * comparison via timingSafeEqual.
 */
export async function verifyPassword(plain, stored) {
  const parts = String(stored || '').split(':')
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false
  const [, n, saltHex, hashHex] = parts
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const derived = await scrypt(String(plain), salt)
  if (derived.length !== expected.length) return false
  return timingSafeEqual(derived, expected)
}

/**
 * Ensure the users table exists. (Also created by migrate.js, but this is
 * safe to call independently.)
 */
export async function ensureUsersTable(db) {
  if (db.kind === 'postgres') {
    await db.query(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE, role TEXT NOT NULL,
      password_hash TEXT, name TEXT, driver_id TEXT, truck_id TEXT, created_at INTEGER NOT NULL
    )`)
  } else {
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE, role TEXT NOT NULL,
      password_hash TEXT, name TEXT, driver_id TEXT, truck_id TEXT, created_at INTEGER NOT NULL
    )`)
  }
}

/**
 * Seed users on first boot from the SEED_USERS list, hashing their passwords.
 * Re-runs are safe (ON CONFLICT DO NOTHING). After seeding, the plaintext seed
 * is no longer the authority — the users table is.
 *
 * @param {object} db  the database (postgres or sqlite)
 * @param {object[]} seedUsers  the SEED_USERS array (from src/data/seed.js)
 */
export async function seedUsers(db, seedUsers) {
  await ensureUsersTable(db)
  const now = Date.now()
  for (const u of seedUsers) {
    const password = u.password || u.pin || 'changeme'
    const hash = await hashPassword(password)
    if (db.kind === 'postgres') {
      await db.query(
        `INSERT INTO users (id, email, role, password_hash, name, driver_id, truck_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (email) DO NOTHING`,
        [u.id, u.email || `${u.truckId}@carrier.local`, u.role, hash, u.name || u.id, u.driverId || null, u.truckId || null, now],
      )
    } else {
      db.prepare(
        `INSERT INTO users (id, email, role, password_hash, name, driver_id, truck_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING`,
      ).run(u.id, u.email || `${u.truckId}@carrier.local`, u.role, hash, u.name || u.id, u.driverId || null, u.truckId || null, now)
    }
  }
}

/**
 * Authenticate a user by email + password. Returns the user record (without the
 * hash) or null. Driver accounts authenticate by truckId + PIN (mapped to an
 * email-shaped record at seed time).
 *
 * @returns {Promise<object|null>}
 */
export async function authenticate(db, email, password) {
  const rows = db.kind === 'postgres'
    ? (await db.query(`SELECT * FROM users WHERE email = $1`, [String(email).toLowerCase()])).rows
    : db.prepare(`SELECT * FROM users WHERE email = ?`).all(String(email).toLowerCase())
  if (!rows.length) return null
  const u = rows[0]
  const ok = await verifyPassword(password, u.password_hash)
  if (!ok) return null
  return { id: u.id, email: u.email, role: u.role, name: u.name, driverId: u.driver_id, truckId: u.truck_id }
}

/**
 * Ensure the tracking_grants table exists (for revocable customer links).
 */
export async function ensureGrantsTable(db) {
  const sql = `CREATE TABLE IF NOT EXISTS tracking_grants (
    token_id TEXT PRIMARY KEY, shipment_id TEXT NOT NULL, exp INTEGER NOT NULL,
    revoked_at INTEGER, issued_at INTEGER NOT NULL, issued_by TEXT
  )`
  if (db.kind === 'postgres') await db.query(sql)
  else db.exec(sql)
}
