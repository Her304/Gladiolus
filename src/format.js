export const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })

export const fmtKm = (km) => `${Math.round(km).toLocaleString('en-CA')} km`

export const pct = (x) => `${Math.round(x * 100)}%`

/** Level -> the colour the map, bars and pills all agree on. */
export const LEVEL_COLOUR = {
  open: '#3ddc97',
  filling: '#4ea3ff',
  tight: '#ffb020',
  full: '#ff6b5e',
}

export const HOS_COLOUR = {
  ok: '#3ddc97',
  warn: '#ffb020',
  critical: '#ff6b5e',
  violation: '#ff4d4d',
}
