/**
 * Phase 7 tests — pilot validation framework.
 *
 * Acceptance gate (plan §5 Phase 7):
 *   - Product claims quote measured pilot results with sample, baseline,
 *     exposure, and limitations.
 *   - No benefit is counted twice, and invoiced detention is separated from
 *     collected detention.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { PILOT_METRICS, comparePilot, buildClaim } from '../src/domain/pilot.js'

describe('Phase 7 — pilot metrics framework', () => {
  test('every metric has a direction (up = favorable / down = favorable)', () => {
    for (const m of PILOT_METRICS) {
      assert.ok(['up', 'down'].includes(m.direction))
      assert.ok(m.label)
    }
  })

  test('detention metrics separate invoiced from collected', () => {
    const ids = PILOT_METRICS.filter((m) => m.kind === 'detention').map((m) => m.id)
    assert.ok(ids.includes('detentionInvoiced'))
    assert.ok(ids.includes('detentionCollected'))
    assert.notEqual(ids.indexOf('detentionInvoiced'), ids.indexOf('detentionCollected'))
  })

  test('a matched baseline-vs-assisted comparison computes net benefit', () => {
    const baseline = {
      matched: true,
      manualTouchesPerLoad: 4,
      feasibleLoadsAccepted: 10,
      detentionCollected: 500,
      detentionInvoiced: 600,
      detentionDisputed: 100,
      avoidableEmptyKm: 2000,
      avgContributionPerLoad: 300,
    }
    const assisted = {
      matched: true,
      manualTouchesPerLoad: 2,
      feasibleLoadsAccepted: 14,
      detentionCollected: 1200,
      detentionInvoiced: 1400,
      detentionDisputed: 80,
      avoidableEmptyKm: 1400,
      avgContributionPerLoad: 300,
      costPerKm: 1.2,
      softwareCost: 800,
    }
    const r = comparePilot(baseline, assisted)
    assert.equal(r.matched, true)
    assert.equal(r.violations.length, 0)
    // collected detention increased
    assert.ok(r.netBenefit.incrementalCollectedDetention > 0)
    // avoidable empty km dropped
    assert.ok(r.netBenefit.avoidedOperatingCost > 0)
    assert.equal(r.detention.collected.assisted, 1200)
    assert.equal(r.detention.invoiced.assisted, 1400)
  })

  test('collected detention exceeding invoiced detention is flagged', () => {
    const r = comparePilot(
      { matched: true, detentionCollected: 100, detentionInvoiced: 200 },
      { matched: true, detentionCollected: 500, detentionInvoiced: 400 },
    )
    assert.ok(r.violations.some((v) => v.includes('collected detention exceeds invoiced')))
  })

  test('a claim without sample/baseline/exposure/limitations is invalid', () => {
    const r = comparePilot({ matched: true }, { matched: true })
    const claim = buildClaim(r, {})
    assert.equal(claim.valid, false)
    assert.match(claim.reason, /sample/)
  })

  test('a complete claim with no violations is valid and quotes the measurement', () => {
    const r = comparePilot(
      { matched: true, detentionCollected: 100, detentionInvoiced: 200 },
      { matched: true, detentionCollected: 300, detentionInvoiced: 400, softwareCost: 50 },
    )
    const claim = buildClaim(r, {
      sample: '8 weeks, 1 carrier',
      baseline: '4-week pre-assist',
      exposure: '12 trucks, 3 lanes',
      limitations: ['single-carrier convenience sample', 'no LTL'],
    })
    assert.equal(claim.valid, true)
    assert.match(claim.statement, /sample=8 weeks/)
    assert.match(claim.statement, /Limitations/)
  })

  test('freed staff time is not counted twice (wages + load contribution)', () => {
    const r = comparePilot(
      { matched: true, feasibleLoadsAccepted: 10, avoidableEmptyKm: 1000 },
      { matched: true, feasibleLoadsAccepted: 12, avoidableEmptyKm: 900, avgContributionPerLoad: 300, savedWages: 2000, doubleCountedFreedTime: true },
    )
    assert.ok(r.violations.some((v) => v.includes('freed staff time')))
  })
})
