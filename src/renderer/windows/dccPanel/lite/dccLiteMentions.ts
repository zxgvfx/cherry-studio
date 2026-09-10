import { type PipelineNodeCatalogItem, pipelineSlashQuickPanelFields } from '@renderer/utils/pipelineNodes'
import { type CocoSessionAsset, cocoSessionAssetPromptText } from '@shared/ai/cocoSessionAssets'
import type { LocalSkill } from '@shared/types/skill'

import type { LiteMentionItem } from './agentChatLiteTypes'

export const LITE_PICK_FILE_ITEM: LiteMentionItem = {
  id: 'pick-file',
  kind: 'pick',
  label: '选择本地文件…',
  insert: '',
  description: '从磁盘标记为附件',
  group: '文件',
  action: 'pick-file'
}

export function buildDccLiteSlashItems(options: {
  nodes?: readonly PipelineNodeCatalogItem[]
  skills?: readonly LocalSkill[]
  mcpTools?: readonly { name: string; description?: string }[]
  mcpServers?: readonly string[]
}): LiteMentionItem[] {
  const nodes = (options.nodes ?? []).map((node) => {
    const fields = pipelineSlashQuickPanelFields(node)
    return {
      id: `node:${node.node_id}`,
      kind: 'node' as const,
      label: fields.label,
      insert: fields.slashId,
      description: fields.slashId,
      group: '画布节点',
      search: `${node.node_id} ${node.tags.join(' ')} ${node.description}`
    }
  })
  const skills = (options.skills ?? []).map((skill) => ({
    id: `skill:${skill.filename}`,
    kind: 'skill' as const,
    label: skill.name,
    insert: `Use the ${skill.name} skill.`,
    description: skill.description || skill.filename,
    group: 'Skill',
    search: skill.filename
  }))
  const tools = (options.mcpTools ?? []).map((tool) => ({
    id: `mcp:${tool.name}`,
    kind: 'mcp' as const,
    label: tool.name,
    insert: `/mcp:${tool.name}`,
    description: tool.description || 'MCP 工具',
    group: 'MCP 工具'
  }))
  const servers =
    tools.length > 0
      ? []
      : (options.mcpServers ?? []).map((server) => ({
          id: `mcp-server:${server}`,
          kind: 'mcp' as const,
          label: server,
          insert: `/mcp:${server}`,
          description: 'MCP 服务',
          group: 'MCP 工具'
        }))
  return [...nodes, ...skills, ...tools, ...servers]
}

export function buildDccLiteFileItems(assets: readonly CocoSessionAsset[] = []): LiteMentionItem[] {
  return [
    LITE_PICK_FILE_ITEM,
    ...assets.map((asset) => ({
      id: `file:${asset.assetId}`,
      kind: 'file' as const,
      label: asset.name,
      insert: cocoSessionAssetPromptText(asset),
      description: asset.caption || '本会话资产',
      group: '文件',
      search: `${asset.assetId} ${asset.origin ?? ''}`,
      payload: { assetId: asset.assetId }
    }))
  ]
}
