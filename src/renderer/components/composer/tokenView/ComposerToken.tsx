import { NormalTooltip, Popover, PopoverContent, PopoverTrigger, Scrollbar } from '@cherrystudio/ui'
import { cn } from '@cherrystudio/ui/lib/utils'
import {
  getQuoteTooltipContent,
  QUOTE_TOOLTIP_BODY_CLASS_NAME,
  QUOTE_TOOLTIP_CONTENT_CLASS_NAME
} from '@renderer/components/composer/quoteToken'
import { BracesVariableIcon } from '@renderer/components/icons/BracesVariableIcon'
import Favicon from '@renderer/components/icons/FallbackFavicon'
import { ipcApi } from '@renderer/ipc'
import { ImagePreviewService } from '@renderer/services/ImagePreviewService'
import { COMPOSER_FILE_KIND, type ComposerFileKind, FILE_TYPE } from '@renderer/types/file'
import { formatFileSize } from '@renderer/utils/file'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'
import { readPipelineNodeTokenPayload } from '@renderer/utils/pipelineNodes'
import type { FileUrlString } from '@shared/types/file'
import { fileUrlToPath } from '@shared/utils/file'
import { Boxes, FileText, Folder, Link2, MessagesSquare, TextQuote, ToolCase, Workflow, X } from 'lucide-react'
import {
  type ComponentType,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'

import type { ChatInputTokenKind, ChatTokenView } from '../chatTokenView'
import { parseComposerLink } from '../linkToken'
import { type FileTokenPresentation, getFileTokenPresentation } from './fileTokenPresentation'
import { PipelineNodeParamForm, usePipelineNodeCatalogItem } from './PipelineNodeParamForm'

const tokenIconClassName = 'size-[1em] shrink-0 text-current opacity-80'
const tokenRemoveIconClassName = 'size-[0.95em] shrink-0 text-current'
const TOKEN_POPOVER_OPEN_DELAY_MS = 120
const TOKEN_POPOVER_CLOSE_DELAY_MS = 160
const TOKEN_TOOLTIP_DELAY_MS = 300
type TokenPopoverOpenReason = 'keyboard' | 'pointer' | 'pinned'
const pinnedComposerPopoverKeys = new Set<string>()

function isComposerPopoverPinned(pinKey: string | undefined) {
  return Boolean(pinKey && pinnedComposerPopoverKeys.has(pinKey))
}

function setComposerPopoverPinned(pinKey: string | undefined, pinned: boolean) {
  if (!pinKey) return
  if (pinned) pinnedComposerPopoverKeys.add(pinKey)
  else pinnedComposerPopoverKeys.delete(pinKey)
}
const tokenPreviewHeaderClassName =
  'flex h-20 items-center justify-center border-border-subtle border-b bg-[repeating-linear-gradient(135deg,var(--border-subtle)_0,var(--border-subtle)_1px,transparent_1px,transparent_8px)] bg-muted'
const pastedTextPreviewCache = new Map<string, Promise<string>>()

const tokenIconByKind: Record<ChatInputTokenKind, ReactNode> = {
  skill: <ToolCase className={tokenIconClassName} />,
  link: <Link2 className={tokenIconClassName} />,
  file: <FileText className={tokenIconClassName} />,
  folder: <Folder className={tokenIconClassName} />,
  knowledge: <Boxes className={tokenIconClassName} />,
  reference: <MessagesSquare className={tokenIconClassName} />,
  quote: <TextQuote className={tokenIconClassName} />,
  pipelineNode: <Workflow className={tokenIconClassName} />,
  promptVariable: <BracesVariableIcon className={tokenIconClassName} />
}

function stopTokenActionEvent(event: ReactMouseEvent<HTMLElement>) {
  event.preventDefault()
  event.stopPropagation()
}

export interface ComposerTokenProps {
  token: ChatTokenView
  readOnly?: boolean
  readOnlyFilePreview?: ReadOnlyComposerFileTokenPreview
  selected?: boolean
  className?: string
  children?: ReactNode
  maxWidthClassName?: string
  onMouseDown?: MouseEventHandler<HTMLSpanElement>
  onRemove?: () => void
  removeLabel?: string
  onPipelineNodeValuesChange?: (values: Record<string, unknown>) => void
}

export interface ReadOnlyComposerFileTokenPreview {
  url?: string
  mediaType?: string
  composerFileKind?: ComposerFileKind
}

interface FileComposerTokenProps extends ComposerTokenProps {
  imageIconPreview?: boolean
  tooltipActions?: ReactNode
}

interface ActiveComposerTokenProps extends ComposerTokenProps {
  icon: ReactNode
  colorClassName?: string
  interactionProps?: {
    role: 'link'
    tabIndex: number
    'aria-label': string
    onClick: MouseEventHandler<HTMLSpanElement>
    onKeyDown: (event: ReactKeyboardEvent<HTMLSpanElement>) => void
  }
}

function InlineTokenRemoveButton({
  label,
  onRemove,
  className,
  iconClassName
}: {
  label: string
  onRemove: () => void
  className?: string
  iconClassName?: string
}) {
  const handleRemove = (event: ReactMouseEvent<HTMLButtonElement>) => {
    stopTokenActionEvent(event)
    onRemove()
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-composer-token-remove=""
      className={cn(
        'pointer-events-none absolute inset-0 inline-flex items-center justify-center border-0 bg-transparent p-0 text-current leading-none opacity-0 outline-none transition-opacity',
        'hover:opacity-100',
        'focus-visible:pointer-events-auto focus-visible:opacity-100',
        'group-focus-within/composer-token:pointer-events-auto group-focus-within/composer-token:opacity-100 group-hover/composer-token:pointer-events-auto group-hover/composer-token:opacity-100',
        className
      )}
      onMouseDown={stopTokenActionEvent}
      onClick={handleRemove}
      onKeyDown={(event) => event.stopPropagation()}>
      <X className={cn(tokenRemoveIconClassName, iconClassName)} aria-hidden />
    </button>
  )
}

function InlineTokenIconSlot({
  icon,
  removeLabel,
  onRemove,
  slotClassName,
  removeButtonClassName,
  removeIconClassName
}: {
  icon: ReactNode
  removeLabel?: string
  onRemove?: () => void
  slotClassName?: string
  removeButtonClassName?: string
  removeIconClassName?: string
}) {
  if (!onRemove) return icon

  // The remove button overlays the icon (absolute) instead of sitting beside it in
  // flow, so it never occupies half of the fixed-size icon slot and shift the icon.
  // Icon and button cross-fade via opacity (not display) to keep the slot from
  // collapsing and to keep the button keyboard-focusable.
  return (
    <span className={cn('relative inline-flex shrink-0', slotClassName)}>
      <span className="inline-flex shrink-0 transition-opacity group-focus-within/composer-token:opacity-0 group-hover/composer-token:opacity-0">
        {icon}
      </span>
      <InlineTokenRemoveButton
        label={removeLabel ?? 'Remove'}
        onRemove={onRemove}
        className={removeButtonClassName}
        iconClassName={removeIconClassName}
      />
    </span>
  )
}

function FileTokenImageIcon({ previewUrl, fallbackIcon }: { previewUrl?: string; fallbackIcon: ReactNode }) {
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>()
  if (!previewUrl || previewUrl === failedPreviewUrl) return fallbackIcon

  return (
    <img
      src={previewUrl}
      alt=""
      aria-hidden
      draggable={false}
      className="block size-4.5! shrink-0 object-cover"
      data-file-token-icon-thumbnail=""
      onError={() => setFailedPreviewUrl(previewUrl)}
    />
  )
}

function isSvgFile(file: ComposerAttachment | undefined, label: string) {
  const extension = file?.ext || label.match(/\.[^.]+$/)?.[0] || ''
  return extension.replace(/^\./, '').toLowerCase() === 'svg'
}

function renderActiveComposerTokenElement({
  token,
  readOnly = false,
  selected = false,
  className,
  children,
  maxWidthClassName = 'max-w-[calc(100%_-_0.25rem)]',
  onMouseDown,
  onRemove,
  removeLabel,
  icon,
  colorClassName = 'text-primary',
  interactionProps
}: ActiveComposerTokenProps) {
  const title = token.kind === 'quote' ? undefined : (token.description ?? token.promptText ?? token.label)

  return (
    <span
      className={cn(
        'group/composer-token mx-0.5 inline-flex select-none items-baseline gap-1 align-baseline leading-[inherit]',
        maxWidthClassName,
        colorClassName,
        readOnly && 'focus-visible:underline focus-visible:underline-offset-2 focus-visible:outline-none',
        selected && 'text-primary underline decoration-primary/40 underline-offset-2',
        className
      )}
      title={title}
      data-composer-token-kind={token.kind}
      onMouseDown={onMouseDown}
      {...interactionProps}>
      <span className="inline-flex shrink-0 translate-y-[0.08em] items-baseline text-current leading-[inherit]">
        <InlineTokenIconSlot
          icon={token.icon ? token.icon : icon}
          removeLabel={removeLabel}
          onRemove={onRemove}
          removeButtonClassName="size-[1em] rounded-[4px]"
        />
      </span>
      {children ?? <span className="min-w-0 truncate">{token.label}</span>}
    </span>
  )
}

function ActiveComposerToken(props: ActiveComposerTokenProps) {
  return renderActiveComposerTokenElement(props)
}

export function SkillComposerToken(props: ComposerTokenProps) {
  return renderActiveComposerTokenElement({
    ...props,
    icon: tokenIconByKind.skill
  })
}

export function LinkComposerToken(props: ComposerTokenProps) {
  const link = parseComposerLink(props.token.promptText ?? props.token.description)
  if (!link) {
    return renderActiveComposerTokenElement({
      ...props,
      icon: tokenIconByKind.link
    })
  }

  const openLink = () => {
    void ipcApi.request('system.shell.open_website', link.url)
  }
  const handleClick: MouseEventHandler<HTMLSpanElement> = (event) => {
    stopTokenActionEvent(event)
    openLink()
  }
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    event.stopPropagation()
    openLink()
  }

  return renderActiveComposerTokenElement({
    ...props,
    className: cn('cursor-pointer rounded-[4px] focus-visible:bg-accent focus-visible:outline-none', props.className),
    icon: props.readOnly ? (
      <span
        className="inline-flex size-[1em] shrink-0 items-center justify-center overflow-hidden rounded-[4px] [&>img]:block [&>img]:size-full! [&>img]:object-contain [&>span]:size-full!"
        data-composer-link-favicon="">
        <Favicon hostname={link.hostname} alt="" />
      </span>
    ) : (
      tokenIconByKind.link
    ),
    children: <span className="min-w-0 truncate">{link.label}</span>,
    interactionProps: {
      role: 'link',
      tabIndex: 0,
      'aria-label': link.url,
      onClick: handleClick,
      onKeyDown: handleKeyDown
    }
  })
}

function isComposerAttachment(value: unknown): value is ComposerAttachment {
  return typeof value === 'object' && value !== null
}

function shouldShowFileTokenPopover(file: ComposerAttachment | undefined) {
  return file?.type === FILE_TYPE.IMAGE || file?.composerFileKind === COMPOSER_FILE_KIND.PASTED_TEXT
}

function readPastedTextPreview(path: string) {
  let request = pastedTextPreviewCache.get(path)
  if (!request) {
    request = window.api.fs.readText(path).catch((error) => {
      pastedTextPreviewCache.delete(path)
      throw error
    })
    pastedTextPreviewCache.set(path, request)
  }
  return request
}

function getReadOnlyFilePreviewPath(readOnlyFilePreview: ReadOnlyComposerFileTokenPreview | undefined) {
  if (!readOnlyFilePreview?.url) return undefined

  try {
    return fileUrlToPath(readOnlyFilePreview.url as FileUrlString)
  } catch {
    return undefined
  }
}

function getPastedTextPreviewPath(
  file: ComposerAttachment | undefined,
  readOnlyFilePreview: ReadOnlyComposerFileTokenPreview | undefined
) {
  return getReadOnlyFilePreviewPath(readOnlyFilePreview) ?? file?.path
}

function TokenPathTooltipContent({ path, sizeLabel }: { path: string; sizeLabel?: string }) {
  return (
    <span className="inline-flex max-w-full items-start gap-2.5 text-left" data-token-path-tooltip="">
      <span className="min-w-0 break-all" data-token-path="">
        {path}
      </span>
      {sizeLabel && (
        <span className="shrink-0 text-neutral-300" data-token-size="">
          {sizeLabel}
        </span>
      )}
    </span>
  )
}

function PastedTextTokenPreviewCard({
  file,
  readOnlyFilePreview,
  secondaryAction
}: {
  file: ComposerAttachment | undefined
  readOnlyFilePreview?: ReadOnlyComposerFileTokenPreview
  secondaryAction?: ReactNode
}) {
  const [previewText, setPreviewText] = useState('')
  const previewPath = getPastedTextPreviewPath(file, readOnlyFilePreview)

  useEffect(() => {
    if (!previewPath) return

    let disposed = false
    void readPastedTextPreview(previewPath)
      .then((text) => {
        if (!disposed) setPreviewText(text)
      })
      .catch(() => {
        if (!disposed) setPreviewText('')
      })

    return () => {
      disposed = true
    }
  }, [previewPath])

  return (
    <div className="w-80 overflow-hidden text-left">
      <Scrollbar className="max-h-44 min-h-24 overflow-x-hidden bg-muted/50" data-file-token-text-scrollbar="">
        <pre className="m-0 whitespace-pre-wrap break-words p-3 font-[inherit] text-popover-foreground text-xs leading-5">
          {previewText}
        </pre>
      </Scrollbar>
      {secondaryAction && (
        <div className="flex justify-end border-border-subtle border-t p-2" data-file-token-actions="">
          {secondaryAction}
        </div>
      )}
    </div>
  )
}

function FileTokenPreviewCard({
  file,
  label,
  presentation,
  readOnlyFilePreview,
  secondaryAction
}: {
  file: ComposerAttachment | undefined
  label: string
  presentation: FileTokenPresentation
  readOnlyFilePreview?: ReadOnlyComposerFileTokenPreview
  secondaryAction?: ReactNode
}) {
  const { t } = useTranslation()
  const sizeLabel = typeof file?.size === 'number' && file.size > 0 ? formatFileSize(file.size) : undefined
  const hasActions = Boolean(secondaryAction)
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string>()
  const hasFailedPreview = Boolean(presentation.previewUrl && presentation.previewUrl === failedPreviewUrl)
  const previewUrl = hasFailedPreview ? undefined : presentation.previewUrl

  if (file?.composerFileKind === COMPOSER_FILE_KIND.PASTED_TEXT) {
    return (
      <PastedTextTokenPreviewCard
        file={file}
        readOnlyFilePreview={readOnlyFilePreview}
        secondaryAction={secondaryAction}
      />
    )
  }

  if (previewUrl) {
    return (
      <div className="flex max-h-48 max-w-60 overflow-hidden bg-muted text-left" data-file-token-image-preview="">
        <img
          src={previewUrl}
          alt={label}
          className="block max-h-48 max-w-60 object-contain"
          onError={() => setFailedPreviewUrl(previewUrl)}
        />
      </div>
    )
  }

  if (hasFailedPreview) {
    return (
      <div
        className="bg-muted px-5 py-4 text-center text-muted-foreground text-sm"
        data-file-token-image-preview-error="">
        {t('chat.input.image_preview_failed')}
      </div>
    )
  }

  return (
    <div className="w-72 overflow-hidden text-left">
      <div className={tokenPreviewHeaderClassName}>
        <span
          className={cn(
            'inline-flex size-12 items-center justify-center rounded-xl bg-background',
            presentation.iconClassName
          )}>
          {presentation.previewIcon}
        </span>
      </div>
      <div className="space-y-2.5 p-3">
        <div
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1"
          data-file-token-actions={hasActions ? '' : undefined}>
          <div className="flex h-6 min-w-0 items-center">
            <span className="truncate font-semibold text-popover-foreground text-sm leading-5">{label}</span>
          </div>
          <div className="flex min-h-4 min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
            <span className="shrink-0 font-medium uppercase">{presentation.typeLabel}</span>
            {sizeLabel && (
              <>
                <span className="text-foreground-tertiary">·</span>
                <span className="shrink-0">{sizeLabel}</span>
              </>
            )}
          </div>
          {secondaryAction && (
            <div className="flex min-h-4 shrink-0 items-center justify-end" onMouseDown={stopTokenActionEvent}>
              {secondaryAction}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface ComposerTokenHoverPopoverProps {
  trigger: ReactNode
  content: ReactNode | ((controls: { closePopover: () => void }) => ReactNode)
  ariaLabel: string
  contentClassName?: string
  onActivate?: () => void
  /** Click the chip to pin the panel until the user clicks elsewhere. Hover remains a preview. */
  pinOnClick?: boolean
  pinKey?: string
}

export function ComposerTokenHoverPopover({
  trigger,
  content,
  ariaLabel,
  contentClassName,
  onActivate,
  pinOnClick = false,
  pinKey
}: ComposerTokenHoverPopoverProps) {
  const [pinned, setPinned] = useState(() => pinOnClick && isComposerPopoverPinned(pinKey))
  const [popoverOpen, setPopoverOpen] = useState(() => pinOnClick && isComposerPopoverPinned(pinKey))
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(pinned)
  const popoverOpenReasonRef = useRef<TokenPopoverOpenReason>(pinned ? 'pinned' : 'pointer')

  pinnedRef.current = pinned

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null) return
    window.clearTimeout(openTimerRef.current)
    openTimerRef.current = null
  }, [])

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }, [])

  const pinPopover = useCallback(() => {
    pinnedRef.current = true
    setComposerPopoverPinned(pinKey, true)
    popoverOpenReasonRef.current = 'pinned'
    clearOpenTimer()
    clearCloseTimer()
    setPinned(true)
    setPopoverOpen(true)
  }, [clearCloseTimer, clearOpenTimer, pinKey])

  const closePopover = useCallback(() => {
    pinnedRef.current = false
    setComposerPopoverPinned(pinKey, false)
    clearOpenTimer()
    clearCloseTimer()
    setPinned(false)
    setPopoverOpen(false)
  }, [clearCloseTimer, clearOpenTimer, pinKey])

  const openPopover = useCallback(
    (reason: TokenPopoverOpenReason = 'pointer') => {
      if (reason === 'pinned') {
        pinPopover()
        return
      }
      popoverOpenReasonRef.current = reason
      clearOpenTimer()
      clearCloseTimer()
      setPopoverOpen(true)
    },
    [clearCloseTimer, clearOpenTimer, pinPopover]
  )

  const openPointerPopover = useCallback(() => {
    if (pinnedRef.current) {
      clearCloseTimer()
      return
    }
    openPopover('pointer')
  }, [clearCloseTimer, openPopover])

  const scheduleOpenPopover = useCallback(() => {
    clearCloseTimer()
    if (popoverOpen || pinnedRef.current || openTimerRef.current !== null) return
    popoverOpenReasonRef.current = 'pointer'

    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null
      setPopoverOpen(true)
    }, TOKEN_POPOVER_OPEN_DELAY_MS)
  }, [clearCloseTimer, popoverOpen])

  const scheduleClosePopover = useCallback(() => {
    if (pinnedRef.current) return
    clearOpenTimer()
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      if (pinnedRef.current) {
        closeTimerRef.current = null
        return
      }
      setPopoverOpen(false)
      closeTimerRef.current = null
    }, TOKEN_POPOVER_CLOSE_DELAY_MS)
  }, [clearCloseTimer, clearOpenTimer])

  const markPointerOpenReason = useCallback(() => {
    if (pinOnClick) {
      pinPopover()
      return
    }
    popoverOpenReasonRef.current = 'pointer'
  }, [pinOnClick, pinPopover])

  const handlePopoverOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        if (pinOnClick && (pinnedRef.current || popoverOpenReasonRef.current === 'pinned')) {
          pinPopover()
          return
        }
        if (popoverOpenReasonRef.current !== 'keyboard' && popoverOpenReasonRef.current !== 'pinned') {
          popoverOpenReasonRef.current = 'pointer'
        }
        clearOpenTimer()
        clearCloseTimer()
        setPopoverOpen(true)
        return
      }

      closePopover()
    },
    [clearCloseTimer, clearOpenTimer, closePopover, pinOnClick, pinPopover]
  )

  const handlePopoverOpenAutoFocus = useCallback((event: Event) => {
    if (popoverOpenReasonRef.current !== 'keyboard' && popoverOpenReasonRef.current !== 'pinned') {
      event.preventDefault()
    }
  }, [])

  const handlePopoverCloseAutoFocus = useCallback((event: Event) => {
    event.preventDefault()
  }, [])

  const isFocusWithinPopover = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) return false
    return Boolean(triggerRef.current?.contains(target) || contentRef.current?.contains(target))
  }, [])

  const handleTriggerBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      if (pinnedRef.current || isFocusWithinPopover(event.relatedTarget)) return
      scheduleClosePopover()
    },
    [isFocusWithinPopover, scheduleClosePopover]
  )

  const handleContentBlur = useCallback(
    (event: ReactFocusEvent<HTMLElement>) => {
      if (pinnedRef.current || isFocusWithinPopover(event.relatedTarget)) return
      scheduleClosePopover()
    },
    [isFocusWithinPopover, scheduleClosePopover]
  )

  const handleTriggerKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if ((event.target as HTMLElement | null)?.closest('[data-composer-token-remove]')) return

      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        if (onActivate) {
          closePopover()
          onActivate()
        } else if (pinOnClick) {
          pinPopover()
        } else {
          openPopover('keyboard')
        }
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePopover()
      }
    },
    [closePopover, onActivate, openPopover, pinOnClick, pinPopover]
  )

  const handleTriggerClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if ((event.target as HTMLElement | null)?.closest('[data-composer-token-remove]')) return

      if (onActivate) {
        stopTokenActionEvent(event)
        closePopover()
        onActivate()
        return
      }

      if (!pinOnClick) return

      stopTokenActionEvent(event)
      pinPopover()
    },
    [closePopover, onActivate, pinOnClick, pinPopover]
  )

  const handleContentPointerDown = useCallback(
    (event: ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>) => {
      event.stopPropagation()
      if (pinOnClick) pinPopover()
    },
    [pinOnClick, pinPopover]
  )

  const handleInteractOutside = useCallback(
    (event: Event) => {
      const target = event.target
      if (target instanceof Node && isFocusWithinPopover(target)) {
        event.preventDefault()
        return
      }
      if (pinOnClick) closePopover()
    },
    [closePopover, isFocusWithinPopover, pinOnClick]
  )

  useEffect(() => {
    if (!pinned) return

    const dismissIfOutside = (event: Event) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (triggerRef.current?.contains(target) || contentRef.current?.contains(target)) return
      closePopover()
    }

    document.addEventListener('pointerdown', dismissIfOutside, true)
    return () => document.removeEventListener('pointerdown', dismissIfOutside, true)
  }, [closePopover, pinned])

  useEffect(
    () => () => {
      clearOpenTimer()
      clearCloseTimer()
    },
    [clearCloseTimer, clearOpenTimer]
  )

  const tokenElement = (
    <span
      ref={triggerRef}
      className="group inline align-baseline outline-none"
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-pressed={pinOnClick ? pinned : undefined}
      data-composer-popover-pinned={pinOnClick ? String(pinned) : undefined}
      onMouseEnter={scheduleOpenPopover}
      onMouseLeave={scheduleClosePopover}
      onMouseMove={scheduleOpenPopover}
      onPointerDown={markPointerOpenReason}
      onClick={handleTriggerClick}
      onBlur={handleTriggerBlur}
      onKeyDownCapture={handleTriggerKeyDown}>
      {trigger}
    </span>
  )

  return (
    <Popover open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
      <PopoverTrigger asChild>{tokenElement}</PopoverTrigger>
      <PopoverContent
        ref={contentRef}
        side="top"
        align="start"
        sideOffset={8}
        className={cn('w-fit max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl p-0 shadow-xl', contentClassName)}
        onMouseEnter={openPointerPopover}
        onMouseLeave={scheduleClosePopover}
        onPointerDown={handleContentPointerDown}
        onMouseDown={handleContentPointerDown}
        onFocus={clearCloseTimer}
        onBlur={handleContentBlur}
        onOpenAutoFocus={handlePopoverOpenAutoFocus}
        onCloseAutoFocus={handlePopoverCloseAutoFocus}
        onInteractOutside={handleInteractOutside}
        onFocusOutside={handleInteractOutside}
        onPointerDownOutside={handleInteractOutside}>
        {typeof content === 'function' ? content({ closePopover }) : content}
      </PopoverContent>
    </Popover>
  )
}

export function FileComposerToken(props: FileComposerTokenProps) {
  const { imageIconPreview = false, onRemove, removeLabel: removeLabelProp, tooltipActions } = props
  const tokenFile = isComposerAttachment(props.token.payload) ? props.token.payload : undefined
  const previewFileType = props.readOnlyFilePreview?.mediaType?.startsWith('image/') ? FILE_TYPE.IMAGE : undefined
  const file = props.readOnlyFilePreview
    ? ({
        ...tokenFile,
        ...(!tokenFile?.type && previewFileType && { type: previewFileType }),
        ...(props.readOnlyFilePreview.composerFileKind && {
          composerFileKind: props.readOnlyFilePreview.composerFileKind
        })
      } as ComposerAttachment)
    : tokenFile
  const label = file?.origin_name || file?.name || props.token.label
  const imagePreviewUrl = props.readOnlyFilePreview?.mediaType?.startsWith('image/')
    ? props.readOnlyFilePreview.url
    : undefined
  const presentation = getFileTokenPresentation(file, label, imagePreviewUrl)
  const openImagePreview = useCallback(() => {
    if (!presentation.previewUrl) return
    void ImagePreviewService.show(presentation.previewUrl)
  }, [presentation.previewUrl])
  const title = props.token.description ?? props.token.promptText ?? label
  const accessibleTitle = props.readOnly ? label : title
  const removeLabel = removeLabelProp ?? 'Remove'
  const shouldShowPopover =
    shouldShowFileTokenPopover(file) && (!props.readOnly || Boolean(props.readOnlyFilePreview?.url))
  const pathTooltipPath = props.readOnly ? getReadOnlyFilePreviewPath(props.readOnlyFilePreview) : file?.path
  const shouldShowPathTooltip = Boolean(pathTooltipPath) && !shouldShowFileTokenPopover(file)
  const shouldUseNeutralImageIcon = imageIconPreview && presentation.variant === 'image'
  const tokenIcon = props.token.icon ? (
    props.token.icon
  ) : shouldUseNeutralImageIcon && !isSvgFile(file, label) ? (
    <FileTokenImageIcon previewUrl={presentation.previewUrl} fallbackIcon={presentation.icon} />
  ) : (
    presentation.icon
  )

  const chipElement = (
    <span
      className={cn(
        'group/composer-token mx-0.5 my-0.5 inline-flex h-6 max-w-[calc(100%_-_0.25rem)] select-none items-center gap-1 overflow-hidden rounded-md border px-1.5 align-middle font-medium text-foreground text-xs leading-[inherit] transition-[color,box-shadow,border-color]',
        'group-focus-visible:border-primary',
        props.readOnly && 'focus-visible:border-primary focus-visible:outline-none',
        presentation.containerClassName,
        props.selected && 'border-primary ring-1 ring-primary/40',
        props.className
      )}
      title={props.readOnly || shouldShowPathTooltip ? undefined : title}
      data-composer-token-kind={props.token.kind}
      data-file-token-variant={presentation.variant}
      onMouseDown={props.onMouseDown}>
      <span
        className={cn(
          'inline-flex size-4.5 shrink-0 items-center justify-center overflow-hidden rounded-[5px] border-0 leading-none',
          shouldUseNeutralImageIcon ? 'bg-accent text-muted-foreground' : presentation.iconClassName
        )}
        data-file-token-icon={presentation.variant}>
        <InlineTokenIconSlot
          icon={tokenIcon}
          removeLabel={removeLabel}
          onRemove={onRemove}
          slotClassName="size-full items-center justify-center"
          removeButtonClassName="size-full rounded-[5px] bg-muted text-foreground"
          removeIconClassName="size-3"
        />
      </span>
      {props.children ?? (
        <span className={cn('whitespace-nowrap! min-w-0 max-w-full truncate break-normal', props.maxWidthClassName)}>
          {label}
        </span>
      )}
    </span>
  )

  if (pathTooltipPath && shouldShowPathTooltip) {
    const sizeLabel = typeof file?.size === 'number' && file.size > 0 ? formatFileSize(file.size) : undefined
    const tooltipContent = <TokenPathTooltipContent path={pathTooltipPath} sizeLabel={sizeLabel} />

    return (
      <NormalTooltip
        content={tooltipContent}
        side="top"
        sideOffset={6}
        delayDuration={TOKEN_TOOLTIP_DELAY_MS}
        triggerProps={props.readOnly ? { tabIndex: 0, 'aria-label': accessibleTitle } : undefined}>
        {chipElement}
      </NormalTooltip>
    )
  }

  if (props.readOnly && !shouldShowPopover) {
    const sizeLabel = typeof file?.size === 'number' && file.size > 0 ? formatFileSize(file.size) : undefined
    const detail = [presentation.typeLabel, sizeLabel].filter(Boolean).join(' · ')

    return (
      <NormalTooltip
        content={<TokenPathTooltipContent path={label} sizeLabel={detail} />}
        side="top"
        sideOffset={6}
        delayDuration={TOKEN_TOOLTIP_DELAY_MS}
        triggerProps={{ tabIndex: 0, 'aria-label': accessibleTitle }}>
        {chipElement}
      </NormalTooltip>
    )
  }

  if (!shouldShowPopover) return chipElement

  return (
    <ComposerTokenHoverPopover
      trigger={chipElement}
      ariaLabel={accessibleTitle}
      contentClassName={presentation.previewUrl ? 'rounded-lg border-0 bg-transparent' : undefined}
      onActivate={presentation.previewUrl ? openImagePreview : undefined}
      content={
        <FileTokenPreviewCard
          file={file}
          label={label}
          presentation={presentation}
          readOnlyFilePreview={props.readOnlyFilePreview}
          secondaryAction={tooltipActions}
        />
      }
    />
  )
}

export function FolderComposerToken(props: ComposerTokenProps) {
  const title = props.token.promptText ?? props.token.description ?? props.token.label
  const path = props.token.promptText ?? props.token.description
  const removeLabel = props.removeLabel ?? 'Remove'

  const chipElement = (
    <span
      className={cn(
        'group/composer-token mx-0.5 my-0.5 inline-flex h-6 max-w-[calc(100%_-_0.25rem)] select-none items-center gap-1 overflow-hidden rounded-md border px-1.5 align-baseline font-medium text-foreground text-xs leading-[inherit] transition-[color,box-shadow,border-color]',
        'group-focus-visible:border-primary',
        props.readOnly && 'focus-visible:border-primary focus-visible:outline-none',
        'border-border bg-background hover:bg-accent',
        props.selected && 'border-primary ring-1 ring-primary/40',
        props.className
      )}
      title={path ? undefined : title}
      data-composer-token-kind={props.token.kind}
      onMouseDown={props.onMouseDown}>
      <span
        className="inline-flex size-4.5 shrink-0 items-center justify-center rounded-[5px] border-0 bg-accent text-muted-foreground leading-none"
        data-folder-token-icon="">
        <InlineTokenIconSlot
          icon={props.token.icon ? props.token.icon : <Folder className={tokenIconClassName} aria-hidden />}
          removeLabel={removeLabel}
          onRemove={props.onRemove}
          removeButtonClassName="size-full rounded-[5px]"
          removeIconClassName="size-3"
        />
      </span>
      {props.children ?? (
        <span className={cn('whitespace-nowrap! min-w-0 max-w-full truncate break-normal', props.maxWidthClassName)}>
          {props.token.label}
        </span>
      )}
    </span>
  )

  if (!path) return chipElement

  return (
    <NormalTooltip
      content={<TokenPathTooltipContent path={path} />}
      side="top"
      sideOffset={6}
      delayDuration={300}
      triggerProps={props.readOnly ? { tabIndex: 0, 'aria-label': props.token.label } : undefined}>
      {chipElement}
    </NormalTooltip>
  )
}

export function KnowledgeComposerToken(props: ComposerTokenProps) {
  return renderActiveComposerTokenElement({
    ...props,
    icon: tokenIconByKind.knowledge
  })
}

export function ReferenceComposerToken(props: ComposerTokenProps) {
  return renderActiveComposerTokenElement({
    ...props,
    icon: tokenIconByKind.reference
  })
}

export function QuoteComposerToken(props: ComposerTokenProps) {
  const quoteTooltipContent = getQuoteTooltipContent(props.token.description, props.token.promptText)
  const tokenElement = renderActiveComposerTokenElement({ ...props, icon: tokenIconByKind.quote })

  if (!quoteTooltipContent) return tokenElement

  return (
    <NormalTooltip
      content={<div className={QUOTE_TOOLTIP_BODY_CLASS_NAME}>{quoteTooltipContent}</div>}
      side="top"
      sideOffset={6}
      delayDuration={300}
      showArrow={false}
      contentProps={{ className: QUOTE_TOOLTIP_CONTENT_CLASS_NAME }}
      triggerProps={props.readOnly ? { tabIndex: 0, 'aria-label': props.token.label } : undefined}>
      {tokenElement}
    </NormalTooltip>
  )
}

export function PromptVariableComposerToken(props: ComposerTokenProps) {
  return <ActiveComposerToken {...props} icon={tokenIconByKind.promptVariable} colorClassName="text-info" />
}

export function PipelineNodeComposerToken(props: ComposerTokenProps) {
  const payload = readPipelineNodeTokenPayload(props.token)
  const node = usePipelineNodeCatalogItem(payload.nodeId)
  const chipElement = renderActiveComposerTokenElement({
    ...props,
    icon: tokenIconByKind.pipelineNode,
    colorClassName: 'text-primary'
  })

  return (
    <ComposerTokenHoverPopover
      trigger={chipElement}
      ariaLabel={props.token.label}
      pinOnClick
      pinKey={props.token.id}
      content={
        <PipelineNodeParamForm
          token={props.token}
          node={node}
          disabled={props.readOnly || !props.onPipelineNodeValuesChange}
          onValuesChange={props.readOnly ? undefined : props.onPipelineNodeValuesChange}
        />
      }
    />
  )
}

export const composerInputTokenComponentByKind = {
  skill: SkillComposerToken,
  link: LinkComposerToken,
  file: FileComposerToken,
  folder: FolderComposerToken,
  knowledge: KnowledgeComposerToken,
  reference: ReferenceComposerToken,
  quote: QuoteComposerToken,
  pipelineNode: PipelineNodeComposerToken,
  promptVariable: PromptVariableComposerToken
} satisfies Record<ChatInputTokenKind, ComponentType<ComposerTokenProps>>

export function ComposerToken(props: ComposerTokenProps) {
  const TokenComponent = composerInputTokenComponentByKind[props.token.kind]
  return <TokenComponent {...props} />
}
