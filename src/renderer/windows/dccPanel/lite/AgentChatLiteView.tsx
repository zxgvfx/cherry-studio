import './agentChatLite.css'

import {
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type SVGProps,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import type {
  AgentChatLiteMode,
  LiteApprovalStatus,
  LiteAsset,
  LiteAttachment,
  LiteFileChip,
  LiteItem,
  LiteMentionItem,
  LiteModelOption,
  LiteModeOption,
  LiteSession
} from './agentChatLiteTypes'
import { applyLiteMention, filterLiteMentions, readLiteMentionTrigger, removeLiteMentionTrigger } from './liteMentions'

function Icon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" {...props} />
  )
}

function ClockIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v5l3 2" />
    </Icon>
  )
}

function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M12 2.5 13.8 8.4 20 10.2 13.8 12 12 17.9 10.2 12 4 10.2 10.2 8.4 12 2.5Z" />
    </svg>
  )
}

function ModelMark() {
  return (
    <Icon width="14" height="14">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 5v2M12 17v2M5 12h2M17 12h2" />
    </Icon>
  )
}

function ChevronIcon() {
  return (
    <Icon width="14" height="14">
      <path d="M6 9l6 6 6-6" />
    </Icon>
  )
}

function McpMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M7 7c4-4 6 4 10 0" />
      <path d="M7 12c4-4 6 4 10 0" />
      <path d="M7 17c4-4 6 4 10 0" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <Icon>
      <rect x="8" y="8" width="10" height="12" rx="2" />
      <path d="M6 16V6a2 2 0 0 1 2-2h8" />
    </Icon>
  )
}

function UpIcon() {
  return (
    <Icon>
      <path d="M7 11v8h3v-8z" />
      <path d="M10 11 12.5 5a2 2 0 0 1 3.8 1.2L15.5 11H19a2 2 0 0 1 1.9 2.6l-1.4 4A3 3 0 0 1 16.6 20H10" />
    </Icon>
  )
}

function DownIcon() {
  return (
    <Icon>
      <g transform="rotate(180 12 12)">
        <path d="M7 11v8h3v-8z" />
        <path d="M10 11 12.5 5a2 2 0 0 1 3.8 1.2L15.5 11H19a2 2 0 0 1 1.9 2.6l-1.4 4A3 3 0 0 1 16.6 20H10" />
      </g>
    </Icon>
  )
}

function InfoIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 11v5M12 8h.01" />
    </Icon>
  )
}

function GlobeIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16" />
    </Icon>
  )
}

function ClipIcon() {
  return (
    <Icon>
      <path d="M8 12.5V8a4 4 0 0 1 8 0v8a3 3 0 0 1-6 0V9" />
    </Icon>
  )
}

function SendIcon() {
  return (
    <Icon>
      <path d="M4 12 20 5l-6 14-2.5-6.5L4 12Z" />
    </Icon>
  )
}

function StopIcon() {
  return (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

function CloseIcon() {
  return (
    <Icon width="12" height="12">
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  )
}

function IconBtn({
  children,
  label,
  onClick,
  pressed
}: {
  children: ReactNode
  label: string
  onClick?: () => void
  pressed?: boolean
}) {
  return (
    <button
      type="button"
      className={pressed ? 'icon-btn is-on' : 'icon-btn'}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}>
      {children}
    </button>
  )
}

function approvalLabel(status: LiteApprovalStatus): string {
  switch (status) {
    case 'pending':
      return ''
    case 'allowed':
    case 'running':
      return '已允许'
    case 'done':
      return '已完成'
    case 'denied':
      return '已拒绝该工具'
    case 'error':
      return '工具执行失败'
    default:
      return status
  }
}

function isImageMedia(mediaType?: string, name?: string): boolean {
  if (mediaType?.startsWith('image/')) return true
  return !!name && /\.(png|jpe?g|webp|gif|bmp|tif|tiff|exr)$/i.test(name)
}

function FileChips({ files }: { files: LiteFileChip[] }) {
  if (files.length === 0) return null
  return (
    <div className="file-chips">
      {files.map((file) =>
        isImageMedia(file.mediaType, file.name) && file.previewUrl ? (
          <img key={file.name} className="file-thumb" src={file.previewUrl} alt={file.name} />
        ) : (
          <span key={file.name} className="file-chip">
            {file.name}
          </span>
        )
      )}
    </div>
  )
}

function AssetCard({
  asset,
  importLabel,
  importing,
  onImport
}: {
  asset: LiteAsset
  importLabel: string
  importing: boolean
  onImport?: (asset: LiteAsset) => void
}) {
  const preview = asset.previewUrl
  const showImage = preview && isImageMedia(asset.assetType, asset.name)
  return (
    <div className="asset-card">
      {showImage ? (
        <img className="asset-preview" src={preview} alt={asset.name} />
      ) : (
        <div className="asset-preview is-model">{asset.assetType || 'asset'}</div>
      )}
      <div className="asset-meta">
        <b>{asset.name}</b>
        <small>{asset.assetType || 'pipeline'}</small>
      </div>
      {importLabel && onImport ? (
        <button
          type="button"
          className="btn btn-allow asset-import"
          disabled={importing}
          onClick={() => onImport(asset)}>
          {importing ? '导入中…' : `导入到 ${importLabel}`}
        </button>
      ) : null}
    </div>
  )
}

export type AgentChatLiteViewProps = {
  mode: AgentChatLiteMode
  title?: string
  subtitle?: string
  agentName: string
  items: LiteItem[]
  sessions: LiteSession[]
  activeSessionId: string | null
  draft: string
  eventsOpen: boolean
  reviewOpenId: string | null
  historyOpen: boolean
  isPending: boolean
  isLoading?: boolean
  errorText?: string
  emptyText?: string
  fineprint?: string
  canCreateSession?: boolean
  attachments?: LiteAttachment[]
  modes?: LiteModeOption[]
  modeId?: string
  models?: LiteModelOption[]
  modelId?: string
  webSearchOn?: boolean
  importLabel?: string
  toolsHint?: string
  slashItems?: LiteMentionItem[]
  fileItems?: LiteMentionItem[]
  onDraftChange: (value: string) => void
  onSend: () => void
  onSelectMention?: (item: LiteMentionItem) => void
  onStop?: () => void
  onCopy?: () => void
  onAllow?: (item: Extract<LiteItem, { kind: 'approval' }>) => void
  onDeny?: (item: Extract<LiteItem, { kind: 'approval' }>) => void
  onSelectSession: (id: string) => void
  onCreateSession?: () => void
  onToggleEvents: () => void
  onToggleHistory: (open: boolean) => void
  onToggleReview: (id: string | null) => void
  onPickFiles?: (files: File[]) => void
  onRemoveAttachment?: (id: string) => void
  onToggleWebSearch?: () => void
  onSelectMode?: (id: string) => void
  onSelectModel?: (id: string) => void
  onImportAsset?: (asset: LiteAsset) => void
}

const FILE_ACCEPT =
  'image/*,video/*,.png,.jpg,.jpeg,.webp,.exr,.hdr,.pdf,.glb,.gltf,.fbx,.obj,.abc,.usd,.usda,.usdc,.hip,.hiplc'

export function AgentChatLiteView({
  mode,
  title = '智能助手',
  subtitle = '有任何关于场景、节点或流水线的问题，直接用中文问我。',
  agentName,
  items,
  sessions,
  activeSessionId,
  draft,
  eventsOpen,
  reviewOpenId,
  historyOpen,
  isPending,
  isLoading,
  errorText,
  emptyText = '开始提问，Agent 会在需要时弹出工具确认。',
  fineprint,
  canCreateSession,
  attachments = [],
  modes = [],
  modeId,
  models = [],
  modelId,
  webSearchOn = false,
  importLabel = '',
  toolsHint = 'DCC 工具已随当前场景自动挂载，无需手动添加。',
  slashItems = [],
  fileItems = [],
  onDraftChange,
  onSend,
  onSelectMention,
  onStop,
  onCopy,
  onAllow,
  onDeny,
  onSelectSession,
  onCreateSession,
  onToggleEvents,
  onToggleHistory,
  onToggleReview,
  onPickFiles,
  onRemoveAttachment,
  onToggleWebSearch,
  onSelectMode,
  onSelectModel,
  onImportAsset
}: AgentChatLiteViewProps) {
  const threadRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const pendingCaretRef = useRef<number | null>(null)
  const [caret, setCaret] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null)
  const [importingId, setImportingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null)
  const [picker, setPicker] = useState<'mode' | 'model' | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !isPending
  const approvals = items.filter((item): item is Extract<LiteItem, { kind: 'approval' }> => item.kind === 'approval')
  const eventSummary = approvals.map((item) => item.toolName).join(' → ') || '等待回复'
  const selectedMode = modes.find((item) => item.id === modeId) ?? modes[0]
  const selectedModel = models.find((item) => item.id === modelId)
  const modelLabel = selectedModel?.label || selectedModel?.id || '模型'

  useEffect(() => {
    const node = threadRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [items, eventsOpen, reviewOpenId, isPending, attachments.length])

  useEffect(() => {
    setBusyApprovalId(null)
  }, [items])

  const respond = (item: Extract<LiteItem, { kind: 'approval' }>, approved: boolean) => {
    setBusyApprovalId(item.id)
    if (approved) onAllow?.(item)
    else onDeny?.(item)
  }

  const takeFiles = (list: FileList | File[] | null) => {
    if (!list || !onPickFiles) return
    const files = Array.from(list).filter((file) => file.size > 0)
    if (files.length) onPickFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    takeFiles(event.dataTransfer.files)
  }

  const trigger = useMemo(() => readLiteMentionTrigger(draft, caret), [caret, draft])
  const mentionSource = trigger?.char === '/' ? slashItems : trigger?.char === '@' ? fileItems : []
  const mentionItems = useMemo(
    () => (trigger ? filterLiteMentions(mentionSource, trigger.query).slice(0, 16) : []),
    [mentionSource, trigger]
  )
  const mentionOpen = Boolean(
    trigger && trigger.start !== dismissedStart && (mentionSource.length > 0 || trigger.query.length > 0)
  )

  useEffect(() => {
    setMentionIndex(0)
  }, [trigger?.char, trigger?.query, trigger?.start])

  useEffect(() => {
    const pos = pendingCaretRef.current
    if (pos == null) return
    pendingCaretRef.current = null
    const node = textareaRef.current
    if (!node) return
    node.focus()
    node.setSelectionRange(pos, pos)
    setCaret(pos)
  }, [draft])

  const syncCaret = () => {
    const node = textareaRef.current
    if (node) setCaret(node.selectionStart)
  }

  const pickMention = (item: LiteMentionItem) => {
    if (!trigger) return
    if (item.action === 'pick-file') {
      const next = removeLiteMentionTrigger(draft, trigger)
      pendingCaretRef.current = next.caret
      onDraftChange(next.text)
      fileInputRef.current?.click()
      return
    }
    const next = applyLiteMention(draft, trigger, item.insert)
    pendingCaretRef.current = next.caret
    onDraftChange(next.text)
    onSelectMention?.(item)
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => (mentionItems.length === 0 ? 0 : (index + 1) % mentionItems.length))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) =>
          mentionItems.length === 0 ? 0 : (index - 1 + mentionItems.length) % mentionItems.length
        )
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissedStart(trigger?.start ?? null)
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && mentionItems[mentionIndex]) {
        event.preventDefault()
        pickMention(mentionItems[mentionIndex])
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      if (canSend) onSend()
    }
  }

  return (
    <div
      className={`dcc-agent-lite ${mode === 'page' ? 'is-page' : 'is-embed'}${dragging ? ' is-drop' : ''}`}
      onDragOver={(event) => {
        if (!onPickFiles) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}>
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept={FILE_ACCEPT}
        onChange={(event) => {
          takeFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <div className="panel">
        <header className="hero">
          <div className="hero-title">
            <span className="live" />
            {title}
          </div>
          <p>{subtitle}</p>
        </header>

        <section className="card">
          <div className="card-top">
            <IconBtn label="历史会话" onClick={() => onToggleHistory(true)}>
              <ClockIcon />
            </IconBtn>
          </div>

          <div className="thread" ref={threadRef}>
            {errorText ? <p className="error-hint">{errorText}</p> : null}
            {!errorText && isLoading && items.length === 0 ? <p className="empty-hint">正在连接对话服务…</p> : null}
            {!errorText && !isLoading && items.length === 0 ? <p className="empty-hint">{emptyText}</p> : null}

            {items.map((item, index) => {
              const showMeta = item.kind !== 'user' && (index === 0 || items[index - 1]?.kind === 'user')
              const meta = showMeta ? (
                <>
                  <div className="agent-meta">
                    <span>
                      <SparkIcon />
                      {agentName}
                    </span>
                    <button type="button" className="ghost" onClick={onToggleEvents}>
                      响应事件
                      <ChevronIcon />
                    </button>
                  </div>
                  {eventsOpen ? <p className="agent-copy">{eventSummary}</p> : null}
                </>
              ) : null

              if (item.kind === 'user') {
                return (
                  <div className="user-bubble" key={item.id}>
                    {item.text ? <div>{item.text}</div> : null}
                    <FileChips files={item.files || []} />
                  </div>
                )
              }
              if (item.kind === 'agent') {
                return (
                  <div key={item.id}>
                    {meta}
                    <p className="agent-copy">{item.text}</p>
                  </div>
                )
              }
              if (item.kind === 'asset') {
                return (
                  <div key={item.id}>
                    {meta}
                    <AssetCard
                      asset={item.asset}
                      importLabel={importLabel}
                      importing={importingId === item.asset.assetId}
                      onImport={
                        onImportAsset
                          ? (asset) => {
                              setImportingId(asset.assetId)
                              onImportAsset(asset)
                              window.setTimeout(() => setImportingId(null), 800)
                            }
                          : undefined
                      }
                    />
                  </div>
                )
              }

              const busy = busyApprovalId === item.id
              const pillClass =
                item.status === 'denied' || item.status === 'error' ? 'no' : item.status === 'pending' ? 'run' : 'ok'
              return (
                <div key={item.id}>
                  {meta}
                  <div className="mcp-card">
                    <div className="mcp-mark">
                      <McpMark />
                    </div>
                    <div>
                      <h3>工具确认</h3>
                      {item.status === 'pending' ? (
                        <p>{item.description}</p>
                      ) : (
                        <span className={`status-pill ${pillClass}`}>
                          {approvalLabel(item.status)} {item.toolName}
                        </span>
                      )}
                    </div>
                    {item.status === 'pending' ? (
                      <div className="mcp-actions">
                        <button
                          type="button"
                          className="btn btn-deny"
                          disabled={busy}
                          onClick={() => respond(item, false)}>
                          拒绝
                        </button>
                        <button
                          type="button"
                          className="btn btn-allow"
                          disabled={busy}
                          onClick={() => respond(item, true)}>
                          允许
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="ghost review"
                      onClick={() => onToggleReview(reviewOpenId === item.id ? null : item.id)}>
                      查看参数
                      <ChevronIcon />
                    </button>
                    {reviewOpenId === item.id ? (
                      <div className="review-body">
                        工具 <code>{item.toolName}</code>
                        {item.inputText ? `\n${item.inputText}` : ''}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            })}

            {isPending ? <p className="agent-copy">正在思考…</p> : null}

            {items.length > 0 ? (
              <div className="feedback">
                <IconBtn label="复制" onClick={onCopy}>
                  <CopyIcon />
                </IconBtn>
                <IconBtn
                  label="有用"
                  pressed={feedback === 'up'}
                  onClick={() => setFeedback((value) => (value === 'up' ? null : 'up'))}>
                  <UpIcon />
                </IconBtn>
                <IconBtn
                  label="没用"
                  pressed={feedback === 'down'}
                  onClick={() => setFeedback((value) => (value === 'down' ? null : 'down'))}>
                  <DownIcon />
                </IconBtn>
              </div>
            ) : null}
          </div>

          <div className="composer-wrap">
            <div className="composer-head">
              {agentName}
              <IconBtn label="工具说明" pressed={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
                <InfoIcon />
              </IconBtn>
            </div>
            {toolsOpen ? <p className="tools-hint">{toolsHint}</p> : null}
            {attachments.length > 0 ? (
              <div className="attach-row">
                {attachments.map((file) => (
                  <span key={file.id} className="attach-chip">
                    {isImageMedia(file.mediaType, file.name) && file.previewUrl ? (
                      <img src={file.previewUrl} alt="" />
                    ) : null}
                    <span>{file.name}</span>
                    <button
                      type="button"
                      aria-label={`移除 ${file.name}`}
                      onClick={() => onRemoveAttachment?.(file.id)}>
                      <CloseIcon />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="composer">
              {mentionOpen ? (
                <div
                  className="mention-menu"
                  role="listbox"
                  aria-label={trigger?.char === '@' ? '标记文件' : '插入节点 Skill 或 MCP'}>
                  {mentionItems.length === 0 ? (
                    <div className="mention-empty">没有匹配项</div>
                  ) : (
                    mentionItems.map((item, index) => {
                      const showGroup = index === 0 || item.group !== mentionItems[index - 1]?.group
                      return (
                        <div key={item.id}>
                          {showGroup ? <div className="mention-group">{item.group}</div> : null}
                          <button
                            type="button"
                            className={index === mentionIndex ? 'active' : ''}
                            onMouseDown={(event) => event.preventDefault()}
                            onMouseEnter={() => setMentionIndex(index)}
                            onClick={() => pickMention(item)}>
                            <b>{item.label}</b>
                            {item.description ? <small>{item.description}</small> : null}
                          </button>
                        </div>
                      )
                    })
                  )}
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                rows={2}
                value={draft}
                placeholder="输入 / 插入画布节点、Skill、MCP，@ 标记文件"
                onChange={(event) => {
                  onDraftChange(event.target.value)
                  setCaret(event.target.selectionStart)
                  setDismissedStart(null)
                }}
                onClick={syncCaret}
                onKeyUp={syncCaret}
                onSelect={syncCaret}
                onPaste={(event) => {
                  const files = event.clipboardData?.files
                  if (files && files.length > 0 && onPickFiles) {
                    event.preventDefault()
                    takeFiles(files)
                  }
                }}
                onKeyDown={onComposerKeyDown}
              />
              <div className="composer-bar">
                <div className="chip-row">
                  <div className="chip-wrap">
                    <button
                      type="button"
                      className="chip"
                      aria-label="Agent 模式"
                      disabled={!onSelectMode || modes.length === 0}
                      onClick={() => setPicker((open) => (open === 'mode' ? null : 'mode'))}>
                      <SparkIcon />
                      <span className="chip-text">{selectedMode?.label || '代理'}</span>
                      {onSelectMode && modes.length > 0 ? <ChevronIcon /> : null}
                    </button>
                    {picker === 'mode' && modes.length > 0 ? (
                      <div className="model-menu is-mode" role="listbox" aria-label="Agent 模式">
                        {modes.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={item.id === (modeId || selectedMode?.id) ? 'active' : ''}
                            onClick={() => {
                              onSelectMode?.(item.id)
                              setPicker(null)
                            }}>
                            <b>{item.label}</b>
                            {item.description ? <small>{item.description}</small> : null}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="chip-wrap">
                    <button
                      type="button"
                      className="chip chip-model"
                      aria-label="模型"
                      disabled={!onSelectModel || models.length === 0}
                      onClick={() => setPicker((open) => (open === 'model' ? null : 'model'))}>
                      <ModelMark />
                      <span className="chip-text">{modelLabel}</span>
                      {onSelectModel && models.length > 0 ? <ChevronIcon /> : null}
                    </button>
                    {picker === 'model' && models.length > 0 ? (
                      <div className="model-menu" role="listbox" aria-label="模型">
                        {models.map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={item.id === modelId ? 'active' : ''}
                            onClick={() => {
                              onSelectModel?.(item.id)
                              setPicker(null)
                            }}>
                            {item.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="bar-icons">
                  <IconBtn label="联网搜索" pressed={webSearchOn} onClick={onToggleWebSearch}>
                    <GlobeIcon />
                  </IconBtn>
                  <IconBtn label="附件" onClick={() => fileInputRef.current?.click()}>
                    <ClipIcon />
                  </IconBtn>
                </div>
                {isPending ? (
                  <button type="button" className="send stop" aria-label="停止" onClick={onStop}>
                    <StopIcon />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={canSend ? 'send ready' : 'send'}
                    aria-label="发送"
                    disabled={!canSend}
                    onClick={onSend}>
                    <SendIcon />
                  </button>
                )}
              </div>
            </div>
          </div>
          {fineprint ? <div className="fineprint">{fineprint}</div> : null}
        </section>
      </div>

      {dragging ? <div className="drop-hint">放到这里，作为本轮附件发给 Agent</div> : null}

      {historyOpen ? (
        <div className="drawer-mask" onClick={() => onToggleHistory(false)}>
          <div
            className="drawer"
            onClick={(event) => {
              event.stopPropagation()
            }}>
            <h2>会话</h2>
            {sessions.map((session) => (
              <button
                key={session.id}
                type="button"
                className={session.id === activeSessionId ? 'session active' : 'session'}
                onClick={() => {
                  onSelectSession(session.id)
                  onToggleHistory(false)
                }}>
                <b>{session.title}</b>
                {session.time ? <small>{session.time}</small> : null}
              </button>
            ))}
            {canCreateSession ? (
              <button type="button" className="new-session" onClick={onCreateSession}>
                新建会话
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
