import { loggerService } from '@logger'
import { defineTool, registerTool } from '@renderer/pages/home/Inputbar/types'
import { Box } from 'lucide-react'
import React, { useEffect, useMemo, useState } from 'react'

const logger = loggerService.withContext('PluginsTool')

interface PluginMode {
  label: string
  description: string
  trigger: string
  mcp_tool?: string
  requires_llm?: boolean
  requires_image?: boolean
}

interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  icon: string
  status: string
  modes: Record<string, PluginMode>
}

let _cachedPlugins: PluginManifest[] | null = null

async function fetchPlugins(): Promise<PluginManifest[]> {
  if (_cachedPlugins) return _cachedPlugins
  const url = `${window.location.origin}/api/v1/plugins/list`
  try {
    const resp = await fetch(url)
    if (!resp.ok) return []
    const data = await resp.json()
    _cachedPlugins = data.plugins || []
    return _cachedPlugins!
  } catch (err) {
    console.error('[PluginsTool] Fetch error:', err)
    return []
  }
}

export function clearPluginCache() {
  _cachedPlugins = null
}

const PluginToolManager: React.FC<{ context: any }> = ({ context }) => {
  const [plugins, setPlugins] = useState<PluginManifest[]>([])
  const { quickPanel } = context

  useEffect(() => {
    fetchPlugins().then((result) => {
      setPlugins(result)
    })
  }, [])

  const menuItems = useMemo(() => {
    if (plugins.length === 0) return []

    const items: Array<{
      label: string
      description: string
      icon: React.ReactNode
      filterText: string
      action: () => void
    }> = []

    for (const plugin of plugins) {
      const modes = plugin.modes || {}
      for (const [, mode] of Object.entries(modes)) {
        items.push({
          label: `${plugin.name} — ${mode.label}`,
          description: mode.description,
          icon: <Box size={16} />,
          filterText: `${plugin.name} ${mode.label} ${mode.trigger} ${mode.description}`,
          action: () => {
            const { actions } = context
            if (actions?.onTextChange) {
              actions.onTextChange((prev: string) => {
                const textArea = document.querySelector('.inputbar textarea') as HTMLTextAreaElement | null
                const cursorPos = textArea?.selectionStart || prev.length
                const before = prev.slice(0, cursorPos)
                const after = prev.slice(cursorPos)
                const lastSlash = before.lastIndexOf('/')

                const toolHint = mode.mcp_tool
                  ? `[使用工具: ${mode.mcp_tool}] `
                  : ''
                const insertText = toolHint + mode.trigger + ' '

                const newText =
                  lastSlash !== -1
                    ? before.slice(0, lastSlash) + insertText + after
                    : before + insertText + after
                const newCursorPos =
                  lastSlash !== -1 ? lastSlash + insertText.length : cursorPos + insertText.length
                setTimeout(() => {
                  if (textArea) {
                    textArea.focus()
                    textArea.setSelectionRange(newCursorPos, newCursorPos)
                  }
                }, 0)
                return newText
              })
            }
          }
        })
      }
    }

    logger.info('Built menu items for plugins', { count: items.length, labels: items.map((i) => i.label) })
    return items
  }, [plugins, context])

  useEffect(() => {
    if (menuItems.length === 0) return
    const cleanup = quickPanel.registerRootMenu(menuItems)
    return () => {
      cleanup()
    }
  }, [menuItems, quickPanel])

  return null
}

const pluginsTool = defineTool({
  key: 'plugins',
  label: (t) => t('plugins.title', 'Plugins'),

  dependencies: {
    actions: ['onTextChange'] as const
  },

  quickPanelManager: PluginToolManager,

  render: null
})

registerTool(pluginsTool)

export default pluginsTool
