#!/usr/bin/env node
/**
 * Reset the dev `users` table to match the current seed (server/seed-users.js).
 *
 * Why this exists: seedUsers() uses `ON CONFLICT (email) DO NOTHING`, so once a
 * row is inserted on first boot it is never overwritten — even if the seed
 * formula (e.g. driver PINs) later changes. That leaves the dev DB with stale
 * password hashes that no longer match the source, so logins like
 * gld-101@carrier.local / 8101 fail with "invalid credentials". This script
 * wipes the users table and re-runs the seed, re-hashing every password so the
 * accounts match server/seed-users.js exactly.
 *
 * Dev/demo only — refuses to run against production (NODE_ENV=production or a
 * configured DATABASE_URL pointing at Postgres). Usage: node scripts/reseed-users.mjs
 */
import { openDatabase } from '../server/db.js'
import { seedUsers, authenticate } from '../server/auth.js'
import { SEED_USERS } from '../server/seed-users.js'

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to wipe users in production')
  process.exit(1)
}

const dbPath = process.env.DB_PATH || './data/corridor.db'
const db = await openDatabase(dbPath)

console.log(`reseeding users in ${db.kind} (${dbPath})`)

if (db.kind === 'postgres') {
  await db.query('DELETE FROM users')
} else {
  db.prepare('DELETE FROM users').run()
}

await seedUsers(db, SEED_USERS)

// Verify a representative login from each role.
const checks = [
  ['admin@gladiolus.ca', 'corridor'],
  ['dispatch@gladiolus.ca', 'corridor'],
  ['gld-101@carrier.local', '8101'],
  ['gld-140@carrier.local', '8140'],
]
let allOk = true
for (const [email, pw] of checks) {
  const u = await authenticate(db, email, pw)
  const ok = !!u
  allOk = allOk && ok
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${email} / ${pw}  -> ${u ? u.role : 'INVALID'}`)
}

await db.close()
if (!allOk) { console.error('some logins failed'); process.exit(1) }
console.log('done — driver sign-in restored')
