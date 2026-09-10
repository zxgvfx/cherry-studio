export type LiteApprovalStatus = 'pending' | 'allowed' | 'denied' | 'running' | 'done' | 'error'

export type LiteApprovalMatch = {
  approvalId: string
  messageId: string
  toolCallId: string
  state: string
  input?: unknown
  part: unknown
}

export type LiteFileChip = {
  name: string
  mediaType?: string
  previewUrl?: string
}

export type LiteAsset = {
  assetId: string
  name: string
  assetType: string
  previewUrl?: string
  downloadUrl?: string
  localPath?: string
}

export type LiteAttachment = {
  id: string
  name: string
  mediaType?: string
  previewUrl?: string
}

export type LiteModeOption = {
  id: string
  label: string
  description?: string
}

export type LiteModelOption = {
  id: string
  label: string
}

export type LiteMentionKind = 'node' | 'skill' | 'mcp' | 'file' | 'pick'

export type LiteMentionItem = {
  id: string
  kind: LiteMentionKind
  label: string
  insert: string
  description?: string
  group: string
  search?: string
  action?: 'pick-file'
  payload?: { assetId?: string }
}

/** Coco `configuration.coco_mode` — DCC 面板不选 Agent，只选模式。 */
export const DCC_LITE_MODES: LiteModeOption[] = [
  { id: 'agent', label: '代理', description: '改场景、跑节点、导入产物' },
  { id: 'plan', label: '规划', description: '只规划方案，不改场景' },
  { id: 'ask', label: '问答', description: '只读提问，不调用写工具' },
  { id: 'debug', label: '调试', description: '排查失败节点和参数' },
  { id: 'multitask', label: '多任务', description: '并行协调多个画布任务' }
]

export type LiteItem =
  | { kind: 'user'; id: string; text: string; files?: LiteFileChip[] }
  | { kind: 'agent'; id: string; text: string }
  | {
      kind: 'approval'
      id: string
      toolName: string
      description: string
      inputText: string
      status: LiteApprovalStatus
      match: LiteApprovalMatch | null
    }
  | { kind: 'asset'; id: string; asset: LiteAsset }

export type LiteSession = {
  id: string
  title: string
  time: string
}

export type AgentChatLiteMode = 'page' | 'embed'
