import { createContext, useContext, useMemo, useSyncExternalStore } from 'react'

const EMPTY_EVENTS = Object.freeze([])

/**
 * React binding for the event store. `useSyncExternalStore` reads a version
 * counter rather than the world object, so a tick that appends 40 pings causes
 * exactly one render instead of forty, and the 40-truck map does not re-fold on
 * every render.
 */
export const StoreContext = createContext(null)
export const SimContext = createContext(null)

export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore must be used inside StoreContext')
  return store
}

export function useSim() {
  return useContext(SimContext)
}

export function useWorld() {
  const store = useStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return store.getWorld()
}

export function useFeed(limit = 30) {
  const store = useStore()
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return store.feed(limit)
}

/**
 * The raw event log — for projections that need to fold domain events (shipment
 * stops, detention) directly rather than reading the v1 truck world. Return a
 * versioned snapshot: the backing array is deliberately stable, while React
 * projections need a new identity whenever that array gains events.
 */
export function useEvents() {
  const store = useStore()
  const version = useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion)
  return useMemo(() => store.events.slice(), [store, version])
}

/** Domain/configuration events without the high-volume GPS telemetry stream. */
export function useOperationalEvents() {
  const store = useStore()
  useSyncExternalStore(
    store.subscribeOperational || store.subscribe,
    store.getOperationalVersion || store.getVersion,
    store.getOperationalVersion || store.getVersion,
  )
  return store.getOperationalEvents ? store.getOperationalEvents() : store.events
}

/** Breadcrumbs for one focused truck, indexed as events arrive. */
export function useTruckPings(truckId) {
  const store = useStore()
  useSyncExternalStore(
    store.subscribeTelemetry || store.subscribe,
    store.getTelemetryVersion || store.getVersion,
    store.getTelemetryVersion || store.getVersion,
  )
  return truckId && store.getTruckPings
    ? store.getTruckPings(truckId)
    : EMPTY_EVENTS
}
