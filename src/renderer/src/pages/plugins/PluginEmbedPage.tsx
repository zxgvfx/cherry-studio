import type { FC } from 'react'
import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'

/** 与后端 prefix_route `/plugins-ui/<plugin-id>/` 约定一致（见各插件 routes.py）。 */
const getPluginFrameSrc = (pluginId: string, queryString: string): string => {
  const backendUrl = (window as { __CHERRY_BACKEND_URL?: string }).__CHERRY_BACKEND_URL || ''
  const baseUrl = backendUrl.replace(/\/$/, '')
  if (!baseUrl) return ''
  const safe = encodeURIComponent(pluginId)
  const basePath = `${baseUrl}/plugins-ui/${safe}/`
  const q = queryString.replace(/^\?/, '')
  return q ? `${basePath}?${q}` : basePath
}

const PluginEmbedPage: FC = () => {
  const { pluginId = '' } = useParams<{ pluginId: string }>()
  const [searchParams] = useSearchParams()
  const queryKey = searchParams.toString()
  const src = useMemo(() => getPluginFrameSrc(pluginId, queryKey), [pluginId, queryKey])

  if (!pluginId) {
    return (
      <Container>
        <Message>缺少插件 ID</Message>
      </Container>
    )
  }

  if (!src) {
    return (
      <Container>
        <Message>未配置后端地址（__CHERRY_BACKEND_URL），无法加载插件页面</Message>
      </Container>
    )
  }

  return (
    <Container>
      <PluginFrame src={src} title={pluginId} />
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  height: 100%;
  flex: 1;
  background: var(--color-background);
  overflow: hidden;
`

const Message = styled.div`
  padding: 24px;
  color: var(--color-text-2);
`

const PluginFrame = styled.iframe`
  width: 100%;
  height: 100%;
  border: 0;
  background: var(--color-background);
`

export default PluginEmbedPage
