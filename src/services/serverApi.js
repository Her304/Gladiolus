import { getToken } from '../auth/AuthContext.jsx'
import { SERVER_ENABLED, apiUrl } from './serverConfig.js'

async function request(path, options = {}) {
  if (!SERVER_ENABLED) return { ok: false, local: true, error: 'shared server is not enabled' }
  const headers = { ...(options.headers || {}) }
  const token = options.token ?? getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (options.body != null && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(apiUrl(path), {
      ...options,
      headers,
      body: options.body == null || typeof options.body === 'string'
        ? options.body
        : JSON.stringify(options.body),
    })
    const body = await res.json().catch(() => ({}))
    return { ...body, ok: res.ok && body.ok !== false, status: res.status }
  } catch (error) {
    return { ok: false, error: error?.message || 'server unreachable' }
  }
}

export function issueCommand(command, token) {
  return request('/api/commands', { method: 'POST', body: command, token })
}

export function exportReviewedDetention(token) {
  return request('/api/integrations/billing/export', { method: 'POST', body: {}, token })
}

export function getProjection(name, token) {
  return request(`/api/projections/${encodeURIComponent(name)}`, { token })
}

export { request as serverRequest }
