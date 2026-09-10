import { COMPOSER_FILE_KIND, FILE_TYPE, type FileMetadata } from '@renderer/types/file'
import type { ComposerAttachment } from '@renderer/utils/message/composerAttachment'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LONG_TEXT_PASTE_THRESHOLD } from '../../composerPaste'
import pasteHandling from '../pasteHandling'

vi.mock('@logger', () => ({
  loggerService: {
    withContext: () => ({
      error: vi.fn(),
      verbose: vi.fn()
    })
  }
}))

describe('pasteHandling', () => {
  const selectedFile: FileMetadata = {
    id: 'file-1',
    name: 'pasted_text.txt',
    origin_name: 'pasted_text.txt',
    path: '/tmp/pasted_text.txt',
    size: 2048,
    ext: '.txt',
    type: FILE_TYPE.TEXT,
    created_at: '2026-06-08T00:00:00.000Z',
    count: 1
  }

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        file: {
          createTempFile: vi.fn().mockResolvedValue('/tmp/pasted_text.txt'),
          get: vi.fn().mockResolvedValue(selectedFile),
          getPathForFile: vi.fn().mockReturnValue(''),
          write: vi.fn()
        }
      }
    })
    Object.defineProperty(window, 'toast', {
      configurable: true,
      value: {
        error: vi.fn(),
        info: vi.fn()
      }
    })
  })

  it('marks long pasted text files with the pasted-text composer kind', async () => {
    const clipboardText = 'x'.repeat(LONG_TEXT_PASTE_THRESHOLD + 1)
    const preventDefault = vi.fn()
    let files: ComposerAttachment[] = []
    const setFiles = vi.fn((updater: (prevFiles: ComposerAttachment[]) => ComposerAttachment[]) => {
      files = updater(files)
    })
    const event = {
      preventDefault,
      clipboardData: {
        getData: (type: string) => (type === 'text' ? clipboardText : ''),
        files: []
      }
    } as unknown as ClipboardEvent

    const handled = await pasteHandling.handlePaste(event, ['.txt'], setFiles, undefined, '', undefined, (key) =>
      key === 'chat.input.pasted_text_file_name' ? 'pasted text.txt' : key
    )

    expect(handled).toBe(true)
    expect(preventDefault).toHaveBeenCalled()
    expect(window.api.file.createTempFile).toHaveBeenCalledWith('pasted_text.txt')
    expect(window.api.file.write).toHaveBeenCalledWith('/tmp/pasted_text.txt', clipboardText)
    expect(files).toEqual([
      {
        fileTokenSourceId: expect.any(String),
        path: selectedFile.path,
        name: selectedFile.name,
        origin_name: 'pasted text.txt',
        ext: selectedFile.ext,
        size: selectedFile.size,
        type: selectedFile.type,
        composerFileKind: COMPOSER_FILE_KIND.PASTED_TEXT
      }
    ])
    expect(files[0]?.fileTokenSourceId).not.toBe(selectedFile.id)
  })

  it('leaves long pasted text untouched when text attachments are unsupported', async () => {
    const clipboardText = 'x'.repeat(LONG_TEXT_PASTE_THRESHOLD + 1)
    const preventDefault = vi.fn()
    const setFiles = vi.fn()
    const event = {
      preventDefault,
      clipboardData: {
        getData: (type: string) => (type === 'text' ? clipboardText : ''),
        files: []
      }
    } as unknown as ClipboardEvent

    const handled = await pasteHandling.handlePaste(event, ['.png'], setFiles)

    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(window.api.file.createTempFile).not.toHaveBeenCalled()
    expect(setFiles).not.toHaveBeenCalled()
  })

  it('leaves short pasted text untouched', async () => {
    const clipboardText = 'x'.repeat(LONG_TEXT_PASTE_THRESHOLD)
    const preventDefault = vi.fn()
    const setFiles = vi.fn()
    const event = {
      preventDefault,
      clipboardData: {
        getData: (type: string) => (type === 'text' ? clipboardText : ''),
        files: []
      }
    } as unknown as ClipboardEvent

    const handled = await pasteHandling.handlePaste(event, [], setFiles, undefined, '')

    expect(handled).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(setFiles).not.toHaveBeenCalled()
  })

  it('uses the clipboard image basename as the display name for a pasted screenshot', async () => {
    const tempImageFile: FileMetadata = {
      ...selectedFile,
      name: 'temp_file_123_image.png',
      origin_name: 'temp_file_123_image.png',
      path: '/tmp/temp_file_123_image.png',
      ext: '.png',
      type: FILE_TYPE.IMAGE
    }
    const clipboardImage = {
      name: 'image.png',
      type: 'image/png',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3]).buffer)
    } as unknown as File
    vi.mocked(window.api.file.createTempFile).mockResolvedValue(tempImageFile.path)
    vi.mocked(window.api.file.get).mockResolvedValue(tempImageFile)

    let files: ComposerAttachment[] = []
    const setFiles = vi.fn((updater: (prevFiles: ComposerAttachment[]) => ComposerAttachment[]) => {
      files = updater(files)
    })
    const event = {
      preventDefault: vi.fn(),
      clipboardData: {
        getData: () => '',
        files: [clipboardImage]
      }
    } as unknown as ClipboardEvent

    const handled = await pasteHandling.handlePaste(event, ['.png'], setFiles)

    expect(handled).toBe(true)
    expect(window.api.file.createTempFile).toHaveBeenCalledWith('image.png')
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      path: tempImageFile.path,
      name: tempImageFile.name,
      origin_name: 'image',
      ext: '.png',
      type: FILE_TYPE.IMAGE
    })
  })

  // Qt/WebEngine has no webUtils.getPathForFile, so every pasted file arrives
  // pathless — gating this branch on image/* made pdf/video/audio unpasteable.
  it('materializes a pasted document the host exposes without a path', async () => {
    const tempPdfFile: FileMetadata = {
      ...selectedFile,
      name: 'report.pdf',
      origin_name: 'report.pdf',
      path: '/tmp/report.pdf',
      ext: '.pdf',
      type: FILE_TYPE.DOCUMENT
    }
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])
    const clipboardPdf = {
      name: 'report.pdf',
      type: 'application/pdf',
      arrayBuffer: vi.fn().mockResolvedValue(pdfBytes.buffer)
    } as unknown as File
    vi.mocked(window.api.file.createTempFile).mockResolvedValue(tempPdfFile.path)
    vi.mocked(window.api.file.get).mockResolvedValue(tempPdfFile)

    let files: ComposerAttachment[] = []
    const setFiles = vi.fn((updater: (prevFiles: ComposerAttachment[]) => ComposerAttachment[]) => {
      files = updater(files)
    })
    const event = {
      preventDefault: vi.fn(),
      clipboardData: {
        getData: () => '',
        files: [clipboardPdf]
      }
    } as unknown as ClipboardEvent

    const handled = await pasteHandling.handlePaste(event, ['.pdf'], setFiles)

    expect(handled).toBe(true)
    expect(window.api.file.createTempFile).toHaveBeenCalledWith('report.pdf')
    expect(window.api.file.write).toHaveBeenCalledWith('/tmp/report.pdf', pdfBytes)
    expect(files).toHaveLength(1)
    // 扩展名必须保留：下游拿 filename 推断 MIME
    expect(files[0]).toMatchObject({
      path: tempPdfFile.path,
      origin_name: 'report.pdf',
      ext: '.pdf',
      type: FILE_TYPE.DOCUMENT
    })
  })

  it('keeps collecting the remaining clipboard files after a pathless document', async () => {
    const firstPdf = {
      name: 'a.pdf',
      type: 'application/pdf',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([1]).buffer)
    } as unknown as File
    const secondPdf = {
      name: 'b.pdf',
      type: 'application/pdf',
      arrayBuffer: vi.fn().mockResolvedValue(new Uint8Array([2]).buffer)
    } as unknown as File
    vi.mocked(window.api.file.createTempFile).mockImplementation(async (name: string) => `/tmp/${name}`)
    vi.mocked(window.api.file.get).mockImplementation(async (path: string) => ({
      ...selectedFile,
      name: path.split('/').pop()!,
      origin_name: path.split('/').pop()!,
      path,
      ext: '.pdf',
      type: FILE_TYPE.DOCUMENT
    }))

    let files: ComposerAttachment[] = []
    const setFiles = vi.fn((updater: (prevFiles: ComposerAttachment[]) => ComposerAttachment[]) => {
      files = updater(files)
    })
    const event = {
      preventDefault: vi.fn(),
      clipboardData: {
        getData: () => '',
        files: [firstPdf, secondPdf]
      }
    } as unknown as ClipboardEvent

    await pasteHandling.handlePaste(event, ['.pdf'], setFiles)

    expect(files.map((file) => file.path)).toEqual(['/tmp/a.pdf', '/tmp/b.pdf'])
  })

  describe('handler registration and lifecycle', () => {
    it('registers a handler and allows manual unregistration', () => {
      const handler = vi.fn().mockResolvedValue(true)

      pasteHandling.init()

      // register
      pasteHandling.registerHandler('inputbar', handler)

      // verify registration
      const event = new Event('paste') as ClipboardEvent
      document.dispatchEvent(event)
      expect(handler).toHaveBeenCalled()

      // unregister via unregisterHandler (matching reference)
      pasteHandling.unregisterHandler('inputbar', handler)

      // verify unregistration
      handler.mockClear()
      document.dispatchEvent(event)
      expect(handler).not.toHaveBeenCalled()
    })

    it('does not unregister if a different handler was registered in the meantime', () => {
      const handler1 = vi.fn().mockResolvedValue(true)
      const handler2 = vi.fn().mockResolvedValue(true)

      pasteHandling.init()

      // register handler1, then handler2 on the same component key
      const cleanup1 = pasteHandling.registerHandler('inputbar', handler1)
      const cleanup2 = pasteHandling.registerHandler('inputbar', handler2)

      // calling cleanup1 should NOT remove handler2 because references differ
      cleanup1()

      const event = new Event('paste') as ClipboardEvent
      document.dispatchEvent(event)
      expect(handler2).toHaveBeenCalled()
      expect(handler1).not.toHaveBeenCalled()

      // calling cleanup2 should successfully remove handler2
      cleanup2()
      handler2.mockClear()
      document.dispatchEvent(event)
      expect(handler2).not.toHaveBeenCalled()
    })

    it('prevents unregisterHandler from removing a newer handler if reference is supplied', () => {
      const handler1 = vi.fn().mockResolvedValue(true)
      const handler2 = vi.fn().mockResolvedValue(true)

      pasteHandling.init()

      pasteHandling.registerHandler('inputbar', handler1)
      pasteHandling.registerHandler('inputbar', handler2)

      // unregisterHandler with handler1 should be ignored since current handler is handler2
      pasteHandling.unregisterHandler('inputbar', handler1)

      const event = new Event('paste') as ClipboardEvent
      document.dispatchEvent(event)
      expect(handler2).toHaveBeenCalled()
    })
  })
})
