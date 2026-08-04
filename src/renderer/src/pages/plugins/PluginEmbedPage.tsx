import { useNavbarPosition } from '@renderer/hooks/useSettings'
import type { FC } from 'react'
import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import styled from 'styled-components'

import { getPluginFrameSrc } from './pluginFrame'

const PluginEmbedPage: FC = () => {
  const { isTopNavbar } = useNavbarPosition()
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

  // 顶部 Tab 模式：iframe 由 PluginTabsPool 保活，此处仅保留路由占位
  if (isTopNavbar) {
    return <TabShell data-plugin-embed-shell aria-hidden />
  }

  return (
    <Container>
      <PluginFrame src={src} title={pluginId} allow="clipboard-read; clipboard-write; fullscreen" />
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

const TabShell = styled.div`
  width: 100%;
  height: 100%;
  flex: 1;
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
