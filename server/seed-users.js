/**
 * Server-only seeded accounts (Phase B).
 *
 * This module is imported only by the server (server/auth.js). It must NEVER be
 * imported by browser code — it contains the plaintext seed passwords that the
 * server hashes on first boot. After seeding, the `users` table (with hashed
 * passwords) is the authority; this list is the bootstrap source only.
 *
 * SEED_DRIVERS (truck/driver fleet, no credentials) is safe for the browser and
 * stays in src/data/seed.js. This file builds the password-bearing account list
 * from it, server-side. Demo driver PINs are intentionally derived only here.
 */
import { SEED_DRIVERS } from '../src/data/seed.js'

export const SEED_USERS = [
  { id: 'U-0', role: 'admin', name: 'Priya Raghunathan', email: 'admin@gladiolus.ca', password: 'corridor' },
  { id: 'U-1', role: 'dispatch', name: 'Kris Aleong', email: 'dispatch@gladiolus.ca', password: 'corridor' },
  { id: 'U-2', role: 'dispatch', name: 'Noor Haddad', email: 'noor@gladiolus.ca', password: 'corridor' },
  ...SEED_DRIVERS.map((d, index) => ({
    id: `U-${d.id}`,
    role: 'driver',
    name: d.name,
    email: `${d.truckId.toLowerCase()}@carrier.local`,
    driverId: d.id,
    truckId: d.truckId,
    pin: String(8101 + index),
    password: String(8101 + index), // drivers authenticate with their PIN
  })),
]
