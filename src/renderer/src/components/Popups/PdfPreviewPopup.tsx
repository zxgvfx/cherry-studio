import { LeftOutlined, MinusOutlined, PlusOutlined, RightOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import { InputNumber, Modal, Spin } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { TopView } from '../TopView'

const logger = loggerService.withContext('PdfPreviewPopup')

const ZOOM_MIN = 25
const ZOOM_MAX = 400
const ZOOM_STEP = 25

interface PdfPageImage {
  data: string
  mime: string
  page: number
}

interface Props {
  filePath: string
  title: string
  resolve: (data: any) => void
}

function getBackendBaseUrl(): string {
  return window.location.origin
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

const PopupContainer: React.FC<Props> = ({ filePath, title, resolve }) => {
  const [open, setOpen] = useState(true)
  const [pages, setPages] = useState<PdfPageImage[]>([])
  const [currentPage, setCurrentPage] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [loading, setLoading] = useState(true)
  const [imagesReady, setImagesReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pageInput, setPageInput] = useState<number | null>(1)
  const pageAreaRef = useRef<HTMLDivElement>(null)
  const { t } = useTranslation()

  useEffect(() => {
    const loadPdf = async () => {
      try {
        const baseUrl = getBackendBaseUrl()
        const resp = await fetch(`${baseUrl}/api/v1/files/pdf-to-images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: filePath, dpi: 150, maxPages: 50 })
        })
        const result = await resp.json()
        if (result.error) {
          setError(result.error)
          setLoading(false)
          return
        }
        if (!result.images || result.images.length === 0) {
          setError(t('files.preview.error'))
          setLoading(false)
          return
        }
        setPages(result.images)
        await preloadAllImages(result.images)
        setImagesReady(true)
      } catch (err) {
        logger.error(`Failed to load PDF: ${filePath}`, err as Error)
        setError(t('files.preview.error'))
      } finally {
        setLoading(false)
      }
    }
    loadPdf()
  }, [filePath, t])

  const preloadAllImages = (images: PdfPageImage[]): Promise<void[]> => {
    return Promise.all(
      images.map(
        (img) =>
          new Promise<void>((res) => {
            const el = new Image()
            el.onload = () => res()
            el.onerror = () => res()
            el.src = `data:${img.mime};base64,${img.data}`
          })
      )
    )
  }

  const goTo = useCallback(
    (page: number) => {
      const p = clamp(page, 0, pages.length - 1)
      setCurrentPage(p)
      setPageInput(p + 1)
    },
    [pages.length]
  )

  const goNext = useCallback(() => goTo(currentPage + 1), [currentPage, goTo])
  const goPrev = useCallback(() => goTo(currentPage - 1), [currentPage, goTo])

  const zoomIn = useCallback(() => setZoom((z) => clamp(z + ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)), [])
  const zoomOut = useCallback(() => setZoom((z) => clamp(z - ZOOM_STEP, ZOOM_MIN, ZOOM_MAX)), [])

  useEffect(() => {
    if (!imagesReady) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT') return

      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        goPrev()
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        goNext()
      } else if ((e.key === '=' || e.key === '+') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        zoomIn()
      } else if (e.key === '-' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        zoomOut()
      } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setZoom(100)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [imagesReady, goNext, goPrev, zoomIn, zoomOut])

  useEffect(() => {
    if (!imagesReady || !pageAreaRef.current) return

    const el = pageAreaRef.current
    const handleWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.deltaY < 0) zoomIn()
        else zoomOut()
      }
    }
    el.addEventListener('wheel', handleWheel, { passive: false })
    return () => el.removeEventListener('wheel', handleWheel)
  }, [imagesReady, zoomIn, zoomOut])

  const onCancel = () => setOpen(false)
  const onClose = () => resolve({})

  PdfPreviewPopup.hide = onCancel

  const isLoading = loading || !imagesReady
  const page = pages[currentPage]

  const handlePageInputConfirm = () => {
    if (pageInput !== null && pageInput >= 1 && pageInput <= pages.length) {
      goTo(pageInput - 1)
    } else {
      setPageInput(currentPage + 1)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      afterClose={onClose}
      title={title}
      width="80vw"
      transitionName="animation-move-down"
      styles={{
        content: { borderRadius: 20, padding: 0, overflow: 'hidden' },
        body: { height: '80vh', maxHeight: 'inherit', padding: 0, display: 'flex', flexDirection: 'column' }
      }}
      centered
      closable={true}
      footer={null}>
      {error ? (
        <CenterContainer>{error}</CenterContainer>
      ) : isLoading ? (
        <CenterContainer>
          <Spin size="large" />
        </CenterContainer>
      ) : (
        <>
          <ViewerContainer>
            <NavButton className="left" $visible={currentPage > 0} onClick={goPrev}>
              <LeftOutlined />
            </NavButton>

            <PageArea ref={pageAreaRef}>
              {page && (
                <PageImage
                  src={`data:${page.mime};base64,${page.data}`}
                  alt={`Page ${page.page}`}
                  draggable={false}
                  style={{ width: `${zoom}%` }}
                />
              )}
            </PageArea>

            <NavButton className="right" $visible={currentPage < pages.length - 1} onClick={goNext}>
              <RightOutlined />
            </NavButton>
          </ViewerContainer>

          <BottomBar>
            <BarSection>
              <ToolBtn onClick={goPrev} disabled={currentPage <= 0}>
                <LeftOutlined />
              </ToolBtn>
              <PageIndicator>
                <StyledPageInput
                  size="small"
                  min={1}
                  max={pages.length}
                  value={pageInput}
                  controls={false}
                  onChange={(v) => setPageInput(v as number)}
                  onPressEnter={handlePageInputConfirm}
                  onBlur={handlePageInputConfirm}
                />
                <span>/ {pages.length}</span>
              </PageIndicator>
              <ToolBtn onClick={goNext} disabled={currentPage >= pages.length - 1}>
                <RightOutlined />
              </ToolBtn>
            </BarSection>

            <Divider />

            <BarSection>
              <ToolBtn onClick={zoomOut} disabled={zoom <= ZOOM_MIN}>
                <MinusOutlined />
              </ToolBtn>
              <ZoomLabel onClick={() => setZoom(100)}>{zoom}%</ZoomLabel>
              <ToolBtn onClick={zoomIn} disabled={zoom >= ZOOM_MAX}>
                <PlusOutlined />
              </ToolBtn>
            </BarSection>
          </BottomBar>
        </>
      )}
    </Modal>
  )
}

const CenterContainer = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--color-text-3);
  font-size: 14px;
`

const ViewerContainer = styled.div`
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  background: var(--color-background-mute);
  user-select: none;
`

const PageArea = styled.div`
  flex: 1;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 16px 48px;
`

const PageImage = styled.img`
  max-height: none;
  object-fit: contain;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.18);
  border-radius: 4px;
  background: white;
  transition: width 0.15s ease;
`

const NavButton = styled.div<{ $visible: boolean }>`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.35);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  cursor: pointer;
  opacity: 0;
  pointer-events: ${(p) => (p.$visible ? 'auto' : 'none')};
  transition: opacity 0.2s;

  &.left {
    left: 12px;
  }
  &.right {
    right: 12px;
  }

  ${ViewerContainer}:hover & {
    opacity: ${(p) => (p.$visible ? 0.7 : 0)};
  }
  &:hover {
    opacity: 1 !important;
    background: rgba(0, 0, 0, 0.6);
  }
`

const BottomBar = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 6px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-background);
`

const BarSection = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
`

const Divider = styled.div`
  width: 1px;
  height: 20px;
  background: var(--color-border);
  margin: 0 8px;
`

const ToolBtn = styled.button<{ disabled?: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: ${(p) => (p.disabled ? 'var(--color-text-4)' : 'var(--color-text-2)')};
  cursor: ${(p) => (p.disabled ? 'default' : 'pointer')};
  font-size: 14px;
  transition: background 0.15s;

  &:hover {
    background: ${(p) => (p.disabled ? 'transparent' : 'var(--color-background-soft)')};
  }
`

const PageIndicator = styled.div`
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--color-text-2);
`

const StyledPageInput = styled(InputNumber)`
  width: 48px;
  .ant-input-number-input {
    text-align: center;
    padding: 0 4px;
    height: 26px;
    font-size: 13px;
  }
`

const ZoomLabel = styled.span`
  font-size: 13px;
  color: var(--color-text-2);
  min-width: 44px;
  text-align: center;
  cursor: pointer;
  border-radius: 4px;
  padding: 2px 4px;

  &:hover {
    background: var(--color-background-soft);
  }
`

const TopViewKey = 'PdfPreviewPopup'

export default class PdfPreviewPopup {
  static topviewId = 0
  static hide() {
    TopView.hide(TopViewKey)
  }
  static show(filePath: string, title: string) {
    return new Promise<any>((resolve) => {
      TopView.show(
        <PopupContainer
          filePath={filePath}
          title={title}
          resolve={(v) => {
            resolve(v)
            TopView.hide(TopViewKey)
          }}
        />,
        TopViewKey
      )
    })
  }
}
