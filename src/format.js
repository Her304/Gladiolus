/** The Highway 401 corridor and simulator operate on Toronto civil time. */
export const TORONTO_TIME_ZONE = 'America/Toronto'

export const fmtTime = (ms) =>
  new Date(ms).toLocaleTimeString('en-CA', {
    timeZone: TORONTO_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

export const fmtDate = (ms) =>
  new Date(ms).toLocaleDateString('en-CA', {
    timeZone: TORONTO_TIME_ZONE,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

/**
 * Set an explicit demo/test hour on the same calendar day in Toronto. Date's
 * setters use the host timezone, which can otherwise shift this clock when the
 * server or a test runner is outside Ontario.
 */
export function torontoTimeAtHour(startAt, hour) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TORONTO_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(new Date(startAt))
  const value = (type) => Number(parts.find((part) => part.type === type)?.value)
  const utcWallTime = Date.UTC(value('year'), value('month') - 1, value('day'), hour)
  const offsetAt = (instant) => {
    const zoned = new Intl.DateTimeFormat('en-CA', {
      timeZone: TORONTO_TIME_ZONE,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant))
    const get = (type) => Number(zoned.find((part) => part.type === type)?.value)
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant
  }

  // Recalculate once because the requested hour can have a different DST
  // offset from the current instant (for example, on a clock-change day).
  const first = utcWallTime - offsetAt(utcWallTime)
  return utcWallTime - offsetAt(first)
}

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
