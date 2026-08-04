import { CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons'
import { Empty, Spin, Tag, Tooltip } from 'antd'
import React, { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface PluginMode {
  label: string
  description: string
  trigger: string
  requires_llm?: boolean
  requires_image?: boolean
}

interface NativePlugin {
  id: string
  name: string
  version: string
  description: string
  icon: string
  status: string
  modes: Record<string, PluginMode>
  output_types: string[]
  dependencies?: {
    servers?: string[]
  }
}

function getBackendBaseUrl(): string {
  return window.location.origin
}

const NativePluginsList: React.FC = () => {
  const { t } = useTranslation()
  const [plugins, setPlugins] = useState<NativePlugin[]>([])
  const [loading, setLoading] = useState(true)
  const [serverStatus, setServerStatus] = useState<Record<string, boolean>>({})

  const fetchPlugins = useCallback(async () => {
    try {
      const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/list`)
      if (!resp.ok) return
      const data = await resp.json()
      setPlugins(data.plugins || [])
    } catch (e) {
      console.error('Failed to fetch native plugins:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const checkServerStatus = useCallback(async (pluginId: string) => {
    try {
      const resp = await fetch(`${getBackendBaseUrl()}/api/v1/plugins/${pluginId}/status`)
      if (!resp.ok) return
      const data = await resp.json()
      const status: Record<string, boolean> = {}
      if (data.sam3_server) status['sam3'] = data.sam3_server.available
      if (data.gen3d_server) status['gen3d'] = data.gen3d_server.available
      setServerStatus(status)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchPlugins()
  }, [fetchPlugins])

  useEffect(() => {
    for (const plugin of plugins) {
      checkServerStatus(plugin.id)
    }
  }, [plugins, checkServerStatus])

  if (loading) {
    return (
      <CenterContainer>
        <Spin />
      </CenterContainer>
    )
  }

  if (plugins.length === 0) {
    return <Empty description={t('plugins.no_installed_plugins', 'No native plugins installed')} />
  }

  return (
    <ListContainer>
      <SectionTitle>{t('plugins.title', 'Plugin Tools')} — Native</SectionTitle>
      {plugins.map((plugin) => (
        <PluginCard key={plugin.id}>
          <CardHeader>
            <PluginIcon>{_getIconEmoji(plugin.icon)}</PluginIcon>
            <HeaderInfo>
              <PluginName>{plugin.name}</PluginName>
              <PluginVersion>v{plugin.version}</PluginVersion>
            </HeaderInfo>
            <StatusTag color={plugin.status === 'loaded' ? 'success' : 'warning'}>{plugin.status}</StatusTag>
          </CardHeader>

          <PluginDescription>{plugin.description}</PluginDescription>

          <ModesContainer>
            {Object.entries(plugin.modes || {}).map(([key, mode]) => (
              <ModeCard key={key}>
                <ModeName>{mode.label}</ModeName>
                <ModeDescription>{mode.description}</ModeDescription>
                <ModeTrigger>
                  <code>{mode.trigger}</code>
                  {mode.requires_llm && (
                    <Tag color="blue" style={{ fontSize: 10, marginLeft: 4 }}>
                      LLM
                    </Tag>
                  )}
                  {mode.requires_image && (
                    <Tag color="green" style={{ fontSize: 10, marginLeft: 4 }}>
                      Image
                    </Tag>
                  )}
                </ModeTrigger>
              </ModeCard>
            ))}
          </ModesContainer>

          {plugin.dependencies?.servers && (
            <DependenciesSection>
              <DepsTitle>Servers</DepsTitle>
              <DepsList>
                {plugin.dependencies.servers.map((srv) => {
                  const name = srv.split(':')[0]
                  const isOnline = serverStatus[name]
                  return (
                    <DepItem key={srv}>
                      <Tooltip title={isOnline ? 'Online' : 'Offline'}>
                        {isOnline ? (
                          <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 4 }} />
                        ) : (
                          <ExclamationCircleOutlined style={{ color: '#faad14', marginRight: 4 }} />
                        )}
                      </Tooltip>
                      <code>{srv}</code>
                    </DepItem>
                  )
                })}
              </DepsList>
            </DependenciesSection>
          )}
        </PluginCard>
      ))}
    </ListContainer>
  )
}

function _getIconEmoji(icon: string): string {
  const map: Record<string, string> = {
    cube: '🧊',
    image: '🖼️',
    code: '💻',
    tool: '🔧'
  }
  return map[icon] || '📦'
}

const CenterContainer = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 200px;
`

const ListContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
`

const SectionTitle = styled.h3`
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-1);
  margin: 0;
`

const PluginCard = styled.div`
  border-radius: 12px;
  border: 1px solid var(--color-border);
  background: var(--color-background-soft);
  padding: 16px;
  transition: border-color 0.2s;

  &:hover {
    border-color: var(--color-primary);
  }
`

const CardHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
`

const PluginIcon = styled.span`
  font-size: 28px;
  line-height: 1;
`

const HeaderInfo = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
`

const PluginName = styled.span`
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text-1);
`

const PluginVersion = styled.span`
  font-size: 11px;
  color: var(--color-text-3);
`

const StatusTag = styled(Tag)`
  margin-left: auto;
`

const PluginDescription = styled.p`
  font-size: 13px;
  color: var(--color-text-2);
  margin: 0 0 12px;
`

const ModesContainer = styled.div`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
`

const ModeCard = styled.div`
  flex: 1;
  min-width: 180px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
`

const ModeName = styled.div`
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-1);
  margin-bottom: 4px;
`

const ModeDescription = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
  margin-bottom: 6px;
`

const ModeTrigger = styled.div`
  display: flex;
  align-items: center;
  font-size: 12px;

  code {
    background: var(--color-background);
    padding: 2px 6px;
    border-radius: 4px;
    font-family: monospace;
    color: var(--color-primary);
  }
`

const DependenciesSection = styled.div`
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
`

const DepsTitle = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-3);
  text-transform: uppercase;
  margin-bottom: 6px;
`

const DepsList = styled.div`
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
`

const DepItem = styled.div`
  display: flex;
  align-items: center;
  font-size: 12px;

  code {
    color: var(--color-text-2);
    font-family: monospace;
  }
`

export default React.memo(NativePluginsList)
