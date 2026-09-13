/**
 * Order-source integration adapter (Phase F).
 *
 * Posts loads into the loadboard from an order/TMS source. Maps external
 * shipment/stop ids to Corridor ids via the identity map, and emits
 * shipment.posted events. A real order source (a carrier's TMS or a load
 * board) fills in poll() with the vendor's API; the interface stays the same.
 */
import { createAdapterBase } from './adapter.js'
import { createLoad } from '../../src/domain/loadboard.js'
import { EVENT } from '../../src/domain/contract.js'

export function createOrdersAdapter({ ingester, identityMap, health, loadBoard, persistIdentity }) {
  const base = createAdapterBase({ ingester, identityMap, health, persistIdentity })

  /** Ingest one order as a posted load. */
  async function ingestOne(order) {
    if (!order?.externalId || !order.originId || !order.destinationId) {
      return { ok: false, error: 'externalId, originId, and destinationId are required' }
    }
    const shipmentId = base.resolve('shipment', 'order', order.externalId) || order.shipmentId || `SHP-${order.externalId}`
    const loadId = order.loadId || `L-${order.externalId}`
    // Register the identity mapping.
    await base.mapId('shipment', 'order', order.externalId, shipmentId)

    const load = createLoad({
      id: loadId,
      shipmentId,
      originId: order.originId,
      destinationId: order.destinationId,
      readyAt: order.readyAt || Date.now(),
      expiresAt: order.expiresAt,
      revenue: order.revenue,
      equipment: order.equipment,
      payloadKg: order.payloadKg,
    })
    const written = await base.ingestOne({
      type: EVENT.SHIPMENT_POSTED,
      observedAt: Date.now(),
      receivedAt: Date.now(),
      providerId: `order:post:${shipmentId}`,
      source: 'order',
      shipmentId,
      loadId,
      kind: order.kind || 'ftl',
      stops: [order.originId, order.destinationId],
      originId: order.originId,
      destinationId: order.destinationId,
      readyAt: load.readyAt,
      appointment: load.appointment,
      serviceTimeMs: load.serviceTimeMs,
      expiresAt: load.expiresAt,
      revenue: load.revenue,
      equipment: load.equipment,
      payloadKg: load.payloadKg,
    })
    if (!written.ok && !written.duplicate) return written
    // createServer's ingest hook normally replays this event into the board;
    // keep the adapter usable in isolation without creating a pre-persist
    // phantom load if the append fails.
    if (!loadBoard._loads.has(loadId)) loadBoard.postLoad(load, 'order-source')
    health.recordSuccess('orders', 'order')
    return { ok: true, loadId, shipmentId }
  }

  /** Webhook handler: POST /api/integrations/orders/webhook */
  async function ingest(payload) {
    const list = Array.isArray(payload) ? payload : [payload]
    const results = []
    for (const order of list) results.push(await ingestOne(order))
    const posted = results.filter((r) => r.ok).length
    return { ok: posted === results.length, posted, results }
  }

  async function poll() {
    if (!process.env.ORDER_API_URL) return
    // A real implementation polls the order/TMS API here.
  }

  return { name: 'orders', ingest, poll, ingestOne, health: base.health }
}
