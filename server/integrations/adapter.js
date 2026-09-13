/**
 * Integration adapter interface (Phase F).
 *
 * Every external source (ELD, order/TMS, billing) implements this shape. The
 * adapter transforms external observations into domain events and writes them
 * through the server's idempotent ingestion boundary (createIngester), so a
 * retried observation never creates a second visit or charge.
 *
 * Real carrier integrations need that carrier's credentials, contract, and
 * endpoint details — which only the carrier can provide. Each adapter below is
 * a real interface with a sample implementation against a representative
 * shape, so a carrier's integration is a configuration task, not an architecture
 * task.
 */

/**
 * @typedef {Object} IntegrationAdapter
 * @property {string} name
 * @property {function(object): Promise<void>} ingest  webhook handler
 * @property {function(): Promise<void>} [poll]         pull-based polling
 * @property {function(): object} health                 freshness + reconciliation
 */

/**
 * Base helpers shared by all adapters.
 */
export function createAdapterBase({ ingester, identityMap, health, persistIdentity }) {
  return {
    /** Ingest one observation through the idempotent boundary. */
    async ingestOne(event) {
      return ingester.ingest(event)
    },
    /** Resolve an external id to a Corridor id via the identity map. */
    resolve(kind, system, externalId) {
      return identityMap.resolve(kind, system, externalId)
    },
    /** Map an external id (registering it if a corridorId is supplied). */
    async mapId(kind, system, externalId, corridorId) {
      const mapping = identityMap.map(kind, system, externalId, corridorId)
      if (persistIdentity) await persistIdentity(mapping)
      return mapping
    },
    health() { return health.health() },
  }
}
