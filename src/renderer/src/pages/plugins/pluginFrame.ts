/** 与后端 prefix_route `/plugins-ui/<plugin-id>/` 约定一致（见各插件 routes.py）。 */
export const getPluginFrameSrc = (pluginId: string, queryString: string): string => {
  const backendUrl = (window as { __CHERRY_BACKEND_URL?: string }).__CHERRY_BACKEND_URL || ''
  const baseUrl = backendUrl.replace(/\/$/, '')
  if (!baseUrl || !pluginId) return ''
  const safe = encodeURIComponent(pluginId)
  const basePath = `${baseUrl}/plugins-ui/${safe}/`
  const q = queryString.replace(/^\?/, '')
  return q ? `${basePath}?${q}` : basePath
}

export const parsePluginIdFromPath = (pathname: string): string => {
  if (!pathname.startsWith('/plugins/')) return ''
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length < 2 || segments[0] !== 'plugins') return ''
  return decodeURIComponent(segments[1])
}
