import { createContext, useContext, useSyncExternalStore } from 'react'

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
