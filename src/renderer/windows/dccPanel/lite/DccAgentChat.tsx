import type { MessageToolApprovalMatch } from '@renderer/components/chat/messages/types'
import { usePipelineNodeCatalog } from '@renderer/components/composer/tokenView'
import { sessionAssetToComposerAttachment } from '@renderer/components/composer/variants/agent/cocoSessionAssetMention'
import { ErrorBoundary } from '@renderer/components/ErrorBoundary'
import { useAgents, useUpdateAgent } from '@renderer/hooks/agent/useAgent'
import { useSessions } from '@renderer/hooks/agent/useSession'
import { useModels } from '@renderer/hooks/useModel'
import { useAvailableSkills } from '@renderer/hooks/useSkills'
import { useAgentChatRuntimeState } from '@renderer/pages/agents/useAgentChatRuntimeState'
import { toast } from '@renderer/services/toast'
import { buildFilePartsForAttachments } from '@renderer/utils/file/buildFileParts'
import { type ComposerAttachment, toComposerAttachment } from '@renderer/utils/message/composerAttachment'
import { readCocoMode } from '@shared/ai/cocoAgent'
import { readCocoSessionAssets } from '@shared/ai/cocoSessionAssets'
import type { CherryMessagePart, CherryUIMessage } from '@shared/data/types/message'
import type { UniqueModelId } from '@shared/data/types/model'
import { toFileUrl } from '@shared/utils/file'
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FallbackProps } from 'react-error-boundary'

import {
  DCC_LITE_MODES,
  type LiteAsset,
  type LiteAttachment,
  type LiteItem,
  type LiteMentionItem,
  type LiteModelOption,
  type LiteSession
} from './agentChatLiteTypes'
import { AgentChatLiteView } from './AgentChatLiteView'
import { buildDccLiteFileItems, buildDccLiteSlashItems } from './dccLiteMentions'
import { lastAgentText, projectAgentLiteItems } from './projectAgentLiteItems'

const EMPTY_MESSAGES: CherryUIMessage[] = []

function formatQueryError(error: unknown): string {
  if (!error) return ''
  if (error instanceof Error) return error.message
  return String(error)
}

function idleLiteView(errorText: string, onRetry?: () => void) {
  return (
    <AgentChatLiteView
      mode="embed"
      agentName="Agent"
      items={[]}
      sessions={[]}
      activeSessionId={null}
      draft=""
      eventsOpen={false}
      reviewOpenId={null}
      historyOpen={false}
      isPending={false}
      errorText={errorText}
      emptyText="开始提问，Agent 会在需要时弹出工具确认。"
      onDraftChange={() => undefined}
      onSend={() => onRetry?.()}
      onSelectSession={() => undefined}
      onToggleEvents={() => undefined}
      onToggleHistory={() => undefined}
      onToggleReview={() => undefined}
    />
  )
}

function DccAgentChatFallback({ error, resetErrorBoundary }: FallbackProps): ReactElement {
  return idleLiteView(formatQueryError(error) || '对话服务暂时不可用', resetErrorBoundary)
}

function dccImportLabel(): string {
  const dcc = (window as Window & { __CHERRY_DCC_TYPE?: string }).__CHERRY_DCC_TYPE || ''
  if (!dcc || dcc === 'standalone' || dcc === 'dcc') return ''
  if (dcc === 'houdini') return 'Houdini'
  if (dcc === 'maya') return 'Maya'
  return dcc
}

function shortModelLabel(modelId?: string | null): string {
  if (!modelId) return ''
  const parts = modelId.split(/[/:]/)
  return parts[parts.length - 1] || modelId
}

function attachmentPreview(file: ComposerAttachment): string | undefined {
  if (file.previewUrl) return file.previewUrl
  if (file.path && file.type === 'image') return toFileUrl(file.path)
  return undefined
}

async function ingestBrowserFiles(files: File[]): Promise<ComposerAttachment[]> {
  const api = window.api?.file
  if (!api?.createTempFile || !api.write || !api.get) {
    throw new Error('当前窗口还不能落盘附件，请稍后重试')
  }
  const next: ComposerAttachment[] = []
  for (const file of files) {
    const existingPath = api.getPathForFile?.(file)
    if (existingPath) {
      const selected = await api.get(existingPath)
      if (selected) next.push(toComposerAttachment(selected))
      continue
    }
    const tempPath = await api.createTempFile(file.name)
    await api.write(tempPath, new Uint8Array(await file.arrayBuffer()))
    const selected = await api.get(tempPath)
    if (selected) next.push(toComposerAttachment(selected))
  }
  return next
}

async function importAssetToDcc(asset: LiteAsset): Promise<void> {
  const win = window as Window & {
    __CHERRY_BACKEND_URL?: string
    __CHERRY_SESSION_ID?: string
    __CHERRY_DCC_TYPE?: string
  }
  const origin = win.__CHERRY_BACKEND_URL?.replace(/\/$/, '') || ''
  const sessionId = win.__CHERRY_SESSION_ID || ''
  if (!origin || !sessionId) {
    throw new Error('当前窗口没有绑定 DCC 会话')
  }
  let localPath = asset.localPath || ''
  if (!localPath && asset.downloadUrl) {
    const response = await fetch(asset.downloadUrl)
    if (!response.ok) throw new Error(`下载产物失败 ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const tempPath = await window.api.file.createTempFile(asset.name)
    await window.api.file.write(tempPath, bytes)
    localPath = tempPath
  }
  if (!localPath) throw new Error('产物还没有本地路径')
  const response = await fetch(`${origin}/api/v1/dcc/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
    body: JSON.stringify({ sessionId, localPath })
  })
  const data = (await response.json()) as { error?: string }
  if (data?.error) throw new Error(data.error)
}

function formatSessionTime(value: string): string {
  const then = Date.parse(value)
  if (!Number.isFinite(then)) return ''
  const delta = Date.now() - then
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.max(1, Math.floor(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${Math.max(1, Math.floor(delta / 3_600_000))} 小时前`
  return new Date(then).toLocaleDateString()
}

function useDccMcpTools(): { name: string; description?: string }[] {
  const [tools, setTools] = useState<{ name: string; description?: string }[]>([])
  useEffect(() => {
    const win = window as Window & { __CHERRY_BACKEND_URL?: string; __CHERRY_SESSION_ID?: string }
    const origin = win.__CHERRY_BACKEND_URL?.replace(/\/$/, '') || ''
    const sessionId = win.__CHERRY_SESSION_ID || ''
    if (!origin || !sessionId) return
    let cancelled = false
    void fetch(`${origin}/api/v1/mcp/list-dcc-tools?sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { 'X-Session-Id': sessionId }
    })
      .then(async (response) => (await response.json()) as { tools?: { name?: string; description?: string }[] })
      .then((data) => {
        if (cancelled) return
        const next = (data.tools ?? [])
          .filter((tool) => typeof tool.name === 'string' && tool.name.trim())
          .map((tool) => ({ name: tool.name!.trim(), description: tool.description }))
        setTools(next)
      })
      .catch(() => {
        if (!cancelled) setTools([])
      })
    return () => {
      cancelled = true
    }
  }, [])
  return tools
}

function DccAgentChatSession({
  sessionId,
  agentId,
  agentName,
  modeId,
  models,
  modelId,
  onSelectMode,
  onSelectModel,
  sessions,
  onSelectSession,
  onCreateSession,
  creating,
  configuration,
  mcps
}: {
  sessionId: string
  agentId: string
  agentName: string
  modeId: string
  models: LiteModelOption[]
  modelId: string
  onSelectMode: (id: string) => void
  onSelectModel: (id: string) => void
  sessions: LiteSession[]
  onSelectSession: (id: string) => void
  onCreateSession: () => void
  creating: boolean
  configuration?: unknown
  mcps?: string[]
}): ReactElement {
  const runtime = useAgentChatRuntimeState({
    sessionId,
    sessionMessagesEnabled: true,
    reservedMessages: EMPTY_MESSAGES
  })
  const [draft, setDraft] = useState('')
  const [eventsOpen, setEventsOpen] = useState(false)
  const [reviewOpenId, setReviewOpenId] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sendError, setSendError] = useState('')
  const [files, setFiles] = useState<ComposerAttachment[]>([])
  const [webSearchOn, setWebSearchOn] = useState(false)
  const { nodes } = usePipelineNodeCatalog(true)
  const { skills } = useAvailableSkills(agentId, undefined, { enabled: true })
  const mcpTools = useDccMcpTools()
  const sessionAssets = useMemo(() => readCocoSessionAssets(configuration, sessionId), [configuration, sessionId])
  const slashItems = useMemo(
    () => buildDccLiteSlashItems({ nodes, skills, mcpTools, mcpServers: mcps }),
    [mcpTools, mcps, nodes, skills]
  )
  const fileItems = useMemo(() => buildDccLiteFileItems(sessionAssets), [sessionAssets])

  const items = useMemo(
    () => projectAgentLiteItems(runtime.uiMessages, runtime.partsByMessageId),
    [runtime.partsByMessageId, runtime.uiMessages]
  )
  const liteAttachments = useMemo<LiteAttachment[]>(
    () =>
      files.map((file) => ({
        id: file.fileTokenSourceId,
        name: file.origin_name || file.name,
        mediaType: file.type === 'image' ? 'image/png' : undefined,
        previewUrl: attachmentPreview(file)
      })),
    [files]
  )

  const send = useCallback(async () => {
    const text = draft.trim()
    if ((!text && files.length === 0) || runtime.isPending) return
    const outgoingText = webSearchOn && text ? `${text}\n\n请在需要时使用联网搜索。` : text
    setDraft('')
    setSendError('')
    try {
      const fileParts = files.length > 0 ? await buildFilePartsForAttachments(files) : []
      setFiles([])
      const parts: CherryMessagePart[] = [
        ...(outgoingText ? [{ type: 'text' as const, text: outgoingText }] : []),
        ...fileParts
      ]
      await runtime.sendMessage(
        { text: outgoingText },
        {
          body: {
            agentId,
            sessionId,
            userMessageParts: parts
          }
        }
      )
    } catch (error) {
      setDraft(text)
      setSendError(error instanceof Error ? error.message : String(error))
    }
  }, [agentId, draft, files, runtime, sessionId, webSearchOn])

  const respond = useCallback(
    async (item: Extract<LiteItem, { kind: 'approval' }>, approved: boolean) => {
      if (!item.match) return
      setSendError('')
      try {
        await runtime.respondToolApproval({
          match: item.match as MessageToolApprovalMatch,
          approved,
          reason: approved ? undefined : 'User denied tool execution'
        })
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error))
      }
    },
    [runtime]
  )

  const copy = useCallback(() => {
    const text = lastAgentText(items)
    if (!text) return
    void navigator.clipboard?.writeText(text)
  }, [items])

  const selectMention = useCallback(
    (item: LiteMentionItem) => {
      const assetId = item.payload?.assetId
      if (item.kind !== 'file' || !assetId) return
      const asset = sessionAssets.find((entry) => entry.assetId === assetId)
      if (!asset) return
      const attachment = sessionAssetToComposerAttachment(asset)
      setFiles((current) =>
        current.some((file) => file.pipelineAssetId === asset.assetId) ? current : [...current, attachment]
      )
    },
    [sessionAssets]
  )

  return (
    <AgentChatLiteView
      mode="embed"
      agentName={agentName.toUpperCase()}
      items={items}
      sessions={sessions}
      activeSessionId={sessionId}
      draft={draft}
      eventsOpen={eventsOpen}
      reviewOpenId={reviewOpenId}
      historyOpen={historyOpen}
      isPending={runtime.isPending}
      isLoading={runtime.isLoading}
      errorText={sendError}
      canCreateSession={!creating}
      onDraftChange={setDraft}
      onSend={() => void send()}
      onStop={() => void runtime.stop()}
      onCopy={copy}
      onAllow={(item) => void respond(item, true)}
      onDeny={(item) => void respond(item, false)}
      onSelectSession={onSelectSession}
      onCreateSession={onCreateSession}
      onToggleEvents={() => setEventsOpen((open) => !open)}
      onToggleHistory={setHistoryOpen}
      onToggleReview={setReviewOpenId}
      attachments={liteAttachments}
      modes={DCC_LITE_MODES}
      modeId={modeId}
      models={models}
      modelId={modelId}
      webSearchOn={webSearchOn}
      importLabel={dccImportLabel()}
      slashItems={slashItems}
      fileItems={fileItems}
      onPickFiles={(picked) => {
        void ingestBrowserFiles(picked)
          .then((next) => setFiles((current) => [...current, ...next]))
          .catch((error) => setSendError(error instanceof Error ? error.message : String(error)))
      }}
      onRemoveAttachment={(id) => setFiles((current) => current.filter((file) => file.fileTokenSourceId !== id))}
      onToggleWebSearch={() => setWebSearchOn((value) => !value)}
      onSelectMode={onSelectMode}
      onSelectModel={onSelectModel}
      onSelectMention={selectMention}
      onImportAsset={(asset) => {
        void importAssetToDcc(asset)
          .then(() => toast.success(`已导入到 ${dccImportLabel() || 'DCC'}`))
          .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
      }}
    />
  )
}

function DccAgentChatBody(): ReactElement {
  const { agents, isLoading: agentsLoading, error: agentsError } = useAgents()
  const { updateAgent, updateModel } = useUpdateAgent()
  const { models } = useModels({ enabled: true })
  const agent = useMemo(() => {
    const cocoAgents = agents.filter((item) => item.type === 'coco')
    return (cocoAgents.length > 0 ? cocoAgents : agents)[0]
  }, [agents])
  const {
    sessions,
    createSession,
    isLoading: sessionsLoading,
    error: sessionsError
  } = useSessions(agent?.id, { enabled: !!agent?.id, pageSize: 20 })
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [errorText, setErrorText] = useState('')
  const creatingRef = useRef(false)
  const [creating, setCreating] = useState(false)
  const modeId = readCocoMode(agent?.configuration)
  const modelId = agent?.model || ''
  const liteModels = useMemo<LiteModelOption[]>(() => {
    const options = models.map((item) => ({
      id: item.id,
      label: item.name?.trim() || shortModelLabel(item.id)
    }))
    if (modelId && !options.some((item) => item.id === modelId)) {
      options.unshift({ id: modelId, label: shortModelLabel(modelId) })
    }
    return options
  }, [modelId, models])

  const handleSelectMode = useCallback(
    (id: string) => {
      if (!agent?.id || id === modeId) return
      void updateAgent({ id: agent.id, configuration: { coco_mode: id } }, { showSuccessToast: false })
    },
    [agent?.id, modeId, updateAgent]
  )

  const handleSelectModel = useCallback(
    (id: string) => {
      if (!agent?.id || id === modelId) return
      void updateModel({ agentId: agent.id, modelId: id as UniqueModelId }, { showSuccessToast: false })
    },
    [agent?.id, modelId, updateModel]
  )

  const liteSessions = useMemo<LiteSession[]>(
    () =>
      sessions.map((session) => ({
        id: session.id,
        title: session.name.trim() || '新对话',
        time: formatSessionTime(session.lastActivityAt || session.updatedAt)
      })),
    [sessions]
  )

  useEffect(() => {
    if (activeSessionId && sessions.some((session) => session.id === activeSessionId)) return
    if (sessions[0]) setActiveSessionId(sessions[0].id)
  }, [activeSessionId, sessions])

  const handleCreateSession = useCallback(async () => {
    if (!agent?.id || creatingRef.current) return
    creatingRef.current = true
    setCreating(true)
    setErrorText('')
    try {
      const created = await createSession({
        name: '',
        workspace: { type: 'system' }
      })
      if (created) setActiveSessionId(created.id)
      else setErrorText('创建会话失败')
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [agent?.id, createSession])

  useEffect(() => {
    if (agentsLoading || sessionsLoading || !agent?.id || sessionsError) return
    if (sessions.length === 0 && !creatingRef.current) void handleCreateSession()
  }, [agent?.id, agentsLoading, handleCreateSession, sessions.length, sessionsError, sessionsLoading])

  const queryError = errorText || formatQueryError(agentsError) || formatQueryError(sessionsError)

  if (!agentsLoading && !agent) {
    return (
      <AgentChatLiteView
        mode="embed"
        agentName="Agent"
        items={[]}
        sessions={[]}
        activeSessionId={null}
        draft=""
        eventsOpen={false}
        reviewOpenId={null}
        historyOpen={false}
        isPending={false}
        errorText={queryError || '未找到 Agent。请先在 Cherry Studio 创建一个 Coco Agent。'}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onSelectSession={() => undefined}
        onToggleEvents={() => undefined}
        onToggleHistory={() => undefined}
        onToggleReview={() => undefined}
      />
    )
  }

  if (!activeSessionId) {
    return (
      <AgentChatLiteView
        mode="embed"
        agentName={agent?.name || 'Agent'}
        items={[]}
        sessions={liteSessions}
        activeSessionId={null}
        draft=""
        eventsOpen={false}
        reviewOpenId={null}
        historyOpen={false}
        isPending={false}
        isLoading={agentsLoading || sessionsLoading || creating}
        errorText={queryError}
        emptyText="正在连接对话服务…"
        canCreateSession={!!agent?.id && !creating}
        modes={DCC_LITE_MODES}
        modeId={modeId}
        models={liteModels}
        modelId={modelId}
        onDraftChange={() => undefined}
        onSend={() => undefined}
        onSelectSession={setActiveSessionId}
        onCreateSession={() => void handleCreateSession()}
        onToggleEvents={() => undefined}
        onToggleHistory={() => undefined}
        onToggleReview={() => undefined}
        onSelectMode={handleSelectMode}
        onSelectModel={handleSelectModel}
      />
    )
  }

  return (
    <DccAgentChatSession
      sessionId={activeSessionId}
      agentId={agent?.id || ''}
      agentName={agent?.name || 'Agent'}
      modeId={modeId}
      models={liteModels}
      modelId={modelId}
      onSelectMode={handleSelectMode}
      onSelectModel={handleSelectModel}
      sessions={liteSessions}
      creating={creating}
      onSelectSession={setActiveSessionId}
      onCreateSession={() => void handleCreateSession()}
      configuration={agent?.configuration}
      mcps={agent?.mcps}
    />
  )
}

export function DccAgentChat(): ReactElement {
  return (
    <ErrorBoundary fallbackComponent={DccAgentChatFallback}>
      <DccAgentChatBody />
    </ErrorBoundary>
  )
}
