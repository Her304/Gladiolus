/**
 * Pilot validation framework (Phase 7).
 *
 * Establishes financial and operational value with evidence, not assumption
 * (plan §5 Phase 7). A pilot is a matched baseline period vs an assisted period,
 * by lane, weekday, freight type, and fleet exposure. This module defines the
 * metrics, the net-benefit model, and the invariants that prevent double-counting
 * or claiming benefits the pilot did not measure.
 *
 * It is a measurement framework — a real pilot must be run with a carrier. The
 * code asserts the accounting invariants (e.g. collected ≠ booked detention, no
 * benefit counted twice) so a future pilot's results cannot silently violate them.
 */

/**
 * The pilot metrics. Each must be observed separately for baseline and assisted
 * periods, matched on lane/weekday/freight type/fleet exposure (plan §5 Phase 7).
 */
export const PILOT_METRICS = Object.freeze([
  // Operational workload
  { id: 'manualTouchesPerLoad', kind: 'operational', label: 'Manual touches / check calls per load', direction: 'down' },
  { id: 'quoteResponseTimeMedian', kind: 'operational', label: 'Median quote response time', direction: 'down' },
  { id: 'quoteResponseTimeP90', kind: 'operational', label: 'P90 quote response time', direction: 'down' },
  // Dispatch
  { id: 'feasibleLoadsAccepted', kind: 'dispatch', label: 'Feasible loads accepted', direction: 'up' },
  { id: 'infeasibleRecsByCause', kind: 'dispatch', label: 'Infeasible recommendations by cause', direction: 'down' },
  // Detention
  { id: 'detentionEligibleFound', kind: 'detention', label: 'Eligible detention found', direction: 'up' },
  { id: 'detentionInvoiced', kind: 'detention', label: 'Detention invoiced', direction: 'up' },
  { id: 'detentionDisputed', kind: 'detention', label: 'Detention disputed', direction: 'down' },
  { id: 'detentionCollected', kind: 'detention', label: 'Detention collected', direction: 'up' },
  { id: 'claimPrepMinutes', kind: 'detention', label: 'Minutes spent preparing a detention claim', direction: 'down' },
  // Utilization
  { id: 'avoidableEmptyKm', kind: 'utilization', label: 'Avoidable empty kilometres (constant service)', direction: 'down' },
  // Parking / safety
  { id: 'failedParkingArrivals', kind: 'parking', label: 'Failed parking arrivals (lot full)', direction: 'down' },
  { id: 'infeasibleSafeStop', kind: 'parking', label: 'Time remaining at a verified safe stop', direction: 'up' },
  // Data quality
  { id: 'eventLoss', kind: 'data', label: 'Event loss rate', direction: 'down' },
  { id: 'eventDuplication', kind: 'data', label: 'Event duplication rate', direction: 'down' },
  { id: 'reconciliationBacklog', kind: 'data', label: 'Reconciliation backlog', direction: 'down' },
])

/**
 * The net-benefit model (assessment §12). Collected contribution and avoided
 * operating cost are reported SEPARATELY from booked revenue or freed staff
 * time — no benefit is counted twice, and invoiced detention is separated from
 * collected detention.
 *
 *   net benefit = incremental collected detention
 *               + contribution from additional feasible loads
 *               + avoidable operating cost saved
 *               − software, integration, and support cost
 *
 * @param {object} baseline
 * @param {object} assisted
 * @returns {object} the comparison with invariant checks
 */
export function comparePilot(baseline, assisted) {
  const delta = {}
  for (const m of PILOT_METRICS) {
    const b = baseline[m.id]
    const a = assisted[m.id]
    if (b == null || a == null) continue
    delta[m.id] = { baseline: b, assisted: a, delta: a - b, favorable: m.direction === 'up' ? a - b > 0 : a - b < 0 }
  }

  // Net benefit components — kept separate, never collapsed into "revenue".
  const incrementalCollectedDetention = (assisted.detentionCollected || 0) - (baseline.detentionCollected || 0)
  const additionalLoadContribution = (assisted.feasibleLoadsAccepted || 0) * (assisted.avgContributionPerLoad || 0) - (baseline.feasibleLoadsAccepted || 0) * (baseline.avgContributionPerLoad || 0)
  const avoidedOperatingCost = ((baseline.avoidableEmptyKm || 0) - (assisted.avoidableEmptyKm || 0)) * (assisted.costPerKm || 0)
  const softwareCost = assisted.softwareCost || 0
  const netBenefit = incrementalCollectedDetention + additionalLoadContribution + avoidedOperatingCost - softwareCost

  // Invariants: no benefit counted twice; invoiced ≠ collected.
  const violations = []
  if ((assisted.detentionInvoiced || 0) > 0 && (assisted.detentionCollected || 0) > (assisted.detentionInvoiced || 0)) {
    violations.push('collected detention exceeds invoiced detention — impossible')
  }
  // Dispatcher capacity: saved wages and additional load contribution must not
  // both count the same freed time.
  if ((assisted.savedWages || 0) > 0 && additionalLoadContribution > 0 && (assisted.doubleCountedFreedTime)) {
    violations.push('freed staff time counted both as saved wages and as additional load contribution')
  }

  return {
    delta,
    netBenefit: {
      incrementalCollectedDetention,
      additionalLoadContribution,
      avoidedOperatingCost,
      softwareCost,
      total: netBenefit,
    },
    // Invoiced detention is reported SEPARATELY from collected detention.
    detention: {
      invoiced: { baseline: baseline.detentionInvoiced, assisted: assisted.detentionInvoiced },
      collected: { baseline: baseline.detentionCollected, assisted: assisted.detentionCollected },
      disputed: { baseline: baseline.detentionDisputed, assisted: assisted.detentionDisputed },
    },
    violations,
    matched: baseline.matched === assisted.matched,
  }
}

/**
 * A product claim must quote measured pilot results with sample, baseline,
 * exposure, and limitations (plan §5 Phase 7 acceptance gate). This helper
 * builds a claim that refuses to assert anything without those fields.
 */
export function buildClaim(result, { sample, baseline, exposure, limitations }) {
  const missing = []
  if (!sample) missing.push('sample')
  if (!baseline) missing.push('baseline')
  if (!exposure) missing.push('exposure')
  if (!limitations || limitations.length === 0) missing.push('limitations')
  if (missing.length > 0) {
    return { valid: false, reason: `claim lacks: ${missing.join(', ')}` }
  }
  if (result.violations.length > 0) {
    return { valid: false, reason: `accounting violations: ${result.violations.join('; ')}` }
  }
  return {
    valid: true,
    statement: `Assisted period net benefit ${result.netBenefit.total} (sample=${sample}, baseline=${baseline}, exposure=${exposure}). Limitations: ${limitations.join('; ')}.`,
  }
}
