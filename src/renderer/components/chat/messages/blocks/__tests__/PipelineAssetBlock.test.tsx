import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@logger', () => ({
  loggerService: { withContext: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}))

vi.mock('../../MessageListProvider', () => ({
  useOptionalMessageListActions: () => null
}))

vi.mock('@renderer/components/FilePreview/plugins/model3d/GLBViewer', () => ({
  default: () => <div data-testid="glb-viewer">viewer</div>
}))

const { captureModelStill } = vi.hoisted(() => ({
  captureModelStill: vi.fn().mockResolvedValue('data:image/jpeg;base64,c3RpbGw=')
}))

vi.mock('@renderer/components/FilePreview/plugins/model3d/captureModelStill', () => ({
  captureModelStill: (...args: unknown[]) => captureModelStill(...args)
}))

import PipelineAssetBlock, { pipelineAssetDownloadUrl, pipelineAssetThumbnailUrl } from '../PipelineAssetBlock'

const glbAsset = {
  assetId: 'asset-1',
  name: 'result.glb',
  assetType: 'model/gltf-binary',
  downloadUrl: 'http://pipeline/api/assets/asset-1/file'
}

const imageAsset = {
  assetId: 'asset-img',
  name: 'style.png',
  assetType: 'media/image',
  downloadUrl: 'http://pipeline/api/assets/asset-img/file'
}

describe('PipelineAssetBlock compact files', () => {
  beforeEach(() => {
    delete (window as Window & { isQtRuntime?: boolean }).isQtRuntime
    captureModelStill.mockClear()
    captureModelStill.mockResolvedValue('data:image/jpeg;base64,c3RpbGw=')
    Object.assign(window.api.file, {
      save: vi.fn().mockResolvedValue('C:\\Downloads\\style.png'),
      createTempFile: vi.fn().mockResolvedValue('C:\\Temp\\style.png'),
      write: vi.fn().mockResolvedValue(undefined),
      startDrag: vi.fn()
    })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
  })

  it('does not auto-mount a 3D viewer in the chat stream', () => {
    render(<PipelineAssetBlock assets={[glbAsset]} />)
    expect(screen.queryByTestId('glb-viewer')).not.toBeInTheDocument()
    expect(screen.getByText('result.glb')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拖到 DCC' })).toBeInTheDocument()
  })

  it('opens a 3D preview only after the file is clicked', async () => {
    render(<PipelineAssetBlock assets={[glbAsset]} />)
    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(await screen.findByTestId('glb-viewer')).toBeInTheDocument()
  })

  it('does not inline the final image; hover shows a thumbnail', () => {
    render(<PipelineAssetBlock assets={[imageAsset]} />)
    expect(screen.queryByRole('img', { name: 'style.png' })).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('button', { name: /style\.png/ }))
    expect(screen.getByAltText('')).toBeInTheDocument()
  })

  it('maps pipeline file urls to the thumbnail endpoint', () => {
    expect(pipelineAssetThumbnailUrl(imageAsset)).toBe('http://pipeline/api/assets/asset-img/thumbnail')
  })

  it('renders a preview-only grid card', () => {
    render(<PipelineAssetBlock assets={[imageAsset]} variant="grid" />)
    const thumb = screen.getByAltText('')
    expect(thumb).toHaveAttribute('src', 'http://pipeline/api/assets/asset-img/thumbnail')
    expect(screen.getByTestId('asset-grid-overlay')).toHaveAttribute('data-visible', 'false')
  })

  it('shows filename and drag/download actions on grid card hover', () => {
    render(<PipelineAssetBlock assets={[imageAsset]} variant="grid" />)
    fireEvent.mouseEnter(screen.getByTestId('asset-grid-card'))
    expect(screen.getByTestId('asset-grid-overlay')).toHaveAttribute('data-visible', 'true')
    expect(screen.getByText('style.png')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拖到 DCC' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '下载' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '预览' })).not.toBeInTheDocument()
  })

  it('downloads through the native save dialog', async () => {
    render(<PipelineAssetBlock assets={[imageAsset]} variant="grid" />)
    fireEvent.mouseEnter(screen.getByTestId('asset-grid-card'))
    fireEvent.click(screen.getByRole('button', { name: '下载' }))

    await waitFor(() => {
      expect(window.api.file.save).toHaveBeenCalledWith('style.png', new Uint8Array([1, 2, 3]))
    })
  })

  it('falls back to DownloadURL while materializing, then starts native drag synchronously', async () => {
    const setData = vi.fn()
    render(<PipelineAssetBlock assets={[imageAsset]} />)
    fireEvent.dragStart(screen.getByRole('button', { name: '拖到 DCC' }), {
      dataTransfer: { effectAllowed: 'none', setData }
    })

    await waitFor(() => {
      expect(window.api.file.write).toHaveBeenCalledWith('C:\\Temp\\style.png', new Uint8Array([1, 2, 3]))
    })
    expect(setData).toHaveBeenCalledWith(
      'DownloadURL',
      `application/octet-stream:style.png:${pipelineAssetDownloadUrl(imageAsset)}`
    )
    expect(window.api.file.startDrag).not.toHaveBeenCalled()

    fireEvent.dragStart(screen.getByRole('button', { name: '拖到 DCC' }), {
      dataTransfer: { effectAllowed: 'none', setData: vi.fn() }
    })
    expect(window.api.file.startDrag).toHaveBeenCalledWith('C:\\Temp\\style.png')
  })

  it('uses the browser download path in Qt so QWebEngine opens its save dialog', async () => {
    ;(window as Window & { isQtRuntime?: boolean }).isQtRuntime = true
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    render(<PipelineAssetBlock assets={[imageAsset]} variant="grid" />)
    fireEvent.mouseEnter(screen.getByTestId('asset-grid-card'))
    fireEvent.click(screen.getByRole('button', { name: '下载' }))

    await waitFor(() => {
      expect(click).toHaveBeenCalledOnce()
      expect(fetch).not.toHaveBeenCalled()
    })
    click.mockRestore()
  })

  it('uses Chromium DownloadURL drag data in Qt instead of the Electron preload', () => {
    ;(window as Window & { isQtRuntime?: boolean }).isQtRuntime = true
    const setData = vi.fn()
    render(<PipelineAssetBlock assets={[imageAsset]} />)
    fireEvent.dragStart(screen.getByRole('button', { name: '拖到 DCC' }), {
      dataTransfer: { effectAllowed: 'none', setData }
    })

    const url = pipelineAssetDownloadUrl(imageAsset)
    expect(setData).toHaveBeenCalledWith('DownloadURL', `application/octet-stream:style.png:${url}`)
    expect(setData).toHaveBeenCalledWith('text/uri-list', url)
    expect(window.api.file.startDrag).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('opens a zoomable image preview when the grid card is clicked', () => {
    render(<PipelineAssetBlock assets={[imageAsset]} variant="grid" />)
    fireEvent.click(screen.getByRole('button', { name: 'style.png' }))
    expect(screen.getByTestId('asset-image-preview')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'style.png' })).toBeInTheDocument()
    expect(screen.getByTestId('asset-image-zoom-value')).toHaveTextContent('100%')

    fireEvent.click(screen.getByTestId('asset-image-zoom-in'))
    expect(screen.getByTestId('asset-image-zoom-value')).toHaveTextContent('125%')
    expect(screen.getByRole('img', { name: 'style.png' })).toHaveStyle({
      transform: 'translate(0px, 0px) scale(1.25)'
    })

    fireEvent.click(screen.getByTestId('asset-image-zoom-out'))
    expect(screen.getByTestId('asset-image-zoom-value')).toHaveTextContent('100%')
  })

  it('captures a still when the model thumbnail fails', async () => {
    render(<PipelineAssetBlock assets={[glbAsset]} variant="grid" />)
    fireEvent.error(screen.getByAltText(''))
    expect(await screen.findByAltText('')).toHaveAttribute('src', 'data:image/jpeg;base64,c3RpbGw=')
    expect(captureModelStill).toHaveBeenCalledWith('http://pipeline/api/assets/asset-1/file')
  })
})
