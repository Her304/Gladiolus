/**
 * One source of truth for the browser/server boundary.
 *
 * In production the Node server serves the Vite bundle and the API from the
 * same origin, so no build-time URL is required.  In development an explicit
 * VITE_SERVER_URL opts into the shared server; leaving it unset keeps the
 * self-contained local simulator available for frontend work.
 */
const configured = String(import.meta.env?.VITE_SERVER_URL || '').replace(/\/$/, '')

export const SERVER_BASE = configured
export const SERVER_ENABLED = Boolean(configured) || Boolean(import.meta.env?.PROD)

export function apiUrl(path) {
  return `${SERVER_BASE}${path.startsWith('/') ? path : `/${path}`}`
}
