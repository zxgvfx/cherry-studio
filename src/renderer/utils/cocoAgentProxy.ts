function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function cocoAgentProxy(method: string, path: string, body?: unknown): Promise<unknown> {
  const proxy = (window as unknown as { qt?: { api?: { agentApiProxy?: (payload: string) => Promise<string> } } }).qt
    ?.api?.agentApiProxy
  if (!proxy) {
    throw new Error('Qt agent API bridge not available')
  }
  const payload: Record<string, unknown> = { method, path }
  if (body !== undefined) payload.body = body
  const raw = await proxy(JSON.stringify(payload))
  const data = typeof raw === 'string' && raw ? JSON.parse(raw) : raw
  if (isRecord(data) && 'error' in data && data.error) {
    const err = data.error
    throw new Error(
      typeof err === 'string' ? err : isRecord(err) ? String(err.message || JSON.stringify(err)) : String(err)
    )
  }
  return data
}
