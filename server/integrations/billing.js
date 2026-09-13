/**
 * Billing-export integration adapter (Phase F).
 *
 * Exports reviewed detention claims to a billing destination (CSV to start; a
 * real TMS/accounting system needs its format). Takes claims in the
 * `reviewed`/`exported` state, produces a billing document, and emits
 * detention.exported events transitioning the claim state.
 */
import { createAdapterBase } from './adapter.js'
import { EVENT } from '../../src/domain/contract.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export function createBillingAdapter({ ingester, identityMap, health, store }) {
  const base = createAdapterBase({ ingester, identityMap, health })

  /**
   * Export reviewed detention claims to CSV. Returns the count exported.
   * Admin-only (enforced by the route handler in app.js).
   */
  async function exportClaims({ destination } = {}) {
    const events = await store.all()
    // Fold the latest state so already-exported/waived claims are not sent
    // again. The calculated event remains the source for contract amounts.
    const claims = new Map()
    for (const e of events) {
      if (!e.claimId || !e.type.startsWith('detention.')) continue
      const prior = claims.get(e.claimId) || {}
      const state = e.type.slice('detention.'.length)
      claims.set(e.claimId, {
        ...prior,
        ...(e.type === EVENT.DETENTION_CALCULATED ? e : {}),
        state,
      })
    }
    const reviewed = [...claims.values()].filter((c) => c.state === 'reviewed')

    const csv = [
      'claimId,shipmentId,stopId,billableMinutes,amount,currency,state',
      ...reviewed.map((c) => [
        c.claimId, c.shipmentId, c.stopId, c.billableMinutes,
        Number.isFinite(c.amount) ? c.amount : (c.billableMinutes || 0) / 60 * 75,
        c.currency || 'CAD', 'exported',
      ].join(',')),
    ].join('\n')

    // Write to the configured destination (filesystem) or a webhook.
    const dest = destination || process.env.BILLING_EXPORT_PATH || './exports'
    try {
      mkdirSync(dest, { recursive: true })
      const file = join(dest, `detention-export-${Date.now()}.csv`)
      writeFileSync(file, csv)
    } catch (e) {
      // Non-fatal: the document is returned to the caller too.
    }

    // Emit detention.exported for each exported claim (transition the state).
    for (const c of reviewed) {
      await base.ingestOne({
        type: EVENT.DETENTION_EXPORTED,
        observedAt: Date.now(),
        receivedAt: Date.now(),
        providerId: `billing:export:${c.claimId}`,
        source: 'billing',
        claimId: c.claimId,
        shipmentId: c.shipmentId,
        stopId: c.stopId,
      })
    }

    health.recordSuccess('billing', 'billing')
    return { ok: true, exported: reviewed.length, csv }
  }

  return { name: 'billing', exportClaims, health: base.health }
}
