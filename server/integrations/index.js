/**
 * Integration registry (Phase F).
 *
 * Creates the identity map + ingestion health (shared across adapters), wires
 * the three adapters (ELD, orders, billing), and exposes their health for the
 * admin console. The server starts poll intervals for pull-based sources.
 */
import { createIdentityMap, createIngestionHealth } from '../../src/domain/integration.js'
import { createEldAdapter } from './eld.js'
import { createOrdersAdapter } from './orders.js'
import { createBillingAdapter } from './billing.js'

export async function createIntegrations({ ingester, store, loadBoard }) {
  const identityMap = createIdentityMap()
  const health = createIngestionHealth()

  const savedMappings = await store.readRecord('identity-map', 'integration')
  for (const m of savedMappings?.data || []) identityMap.map(m.kind, m.system, m.externalId, m.corridorId)

  async function persistIdentity(mapping) {
    const mappings = [...identityMap._byKey.entries()].map(([key, corridorId]) => {
      const [kind, system, ...externalParts] = key.split(':')
      return { kind, system, externalId: externalParts.join(':'), corridorId }
    })
    await store.writeRecord('identity-map', 'integration', mappings)
    return mapping
  }

  const eld = createEldAdapter({ ingester, identityMap, health, loadBoard, store, persistIdentity })
  const orders = createOrdersAdapter({ ingester, identityMap, health, loadBoard, persistIdentity })
  const billing = createBillingAdapter({ ingester, identityMap, health, store })

  let pollTimer = null
  function startPolling(intervalMs = 60_000) {
    if (pollTimer) return
    pollTimer = setInterval(async () => {
      try { await eld.poll() } catch {}
      try { await orders.poll() } catch {}
    }, intervalMs)
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null } }

  function healthReport() {
    return {
      eld: eld.health(),
      orders: orders.health(),
      billing: billing.health(),
      reconciliation: health.reconciliationQueue(),
    }
  }

  return { eld, orders, billing, identityMap, health, startPolling, stopPolling, healthReport }
}
