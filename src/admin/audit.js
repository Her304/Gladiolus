import { store } from '../runtime.js'
import { EVENT } from '../contract.js'

/**
 * Administrator actions go through the log like everything else.
 *
 * This is not decoration. The rule the whole app is built on is that the event
 * log is the only source of truth — so a config change that mutated state
 * without appending an event would be the one thing in the system nobody could
 * reconstruct by replaying. It also means the audit trail costs a fold rather
 * than a table.
 */
export function logAdminAction(actor, action, detail = null) {
  const at = store.getWorld().clock || Date.now()
  store.append(EVENT.ADMIN_ACTION, at, {
    actor: actor?.email || actor?.name || 'unknown',
    action,
    detail,
  })
  store.commit()
}

/** Actions worth naming once, so the audit view and the feed agree on wording. */
export const ACTION = {
  CAPACITY_SET: 'changed site capacity',
  CAPACITY_RESET: 'reset site capacity',
  OVERRIDES_CLEARED: 'cleared all overrides',
  SIM_SPEED: 'changed simulation speed',
  CREDENTIALS_REVEALED: 'revealed seeded credentials',
  LOG_EXPORTED: 'exported the event log',
}
