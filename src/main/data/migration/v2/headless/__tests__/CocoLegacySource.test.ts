import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { prepareCocoLegacyMigrationPayload, resolveCocoLegacySource } from '../CocoLegacySource'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-migration-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  delete process.env.CHERRY_HEADLESS_LEGACY_LOCAL_STORAGE
  delete process.env.CHERRY_HEADLESS_LEGACY_INDEXED_DB
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('CoCoLegacySource', () => {
  it('requires both legacy JSON exports', () => {
    const dir = tempDir()
    const localStorageFile = path.join(dir, 'localStorage.json')
    fs.writeFileSync(localStorageFile, '{}')
    process.env.CHERRY_HEADLESS_LEGACY_LOCAL_STORAGE = localStorageFile
    process.env.CHERRY_HEADLESS_LEGACY_INDEXED_DB = path.join(dir, 'missing.json')

    expect(resolveCocoLegacySource()).toBeNull()
  })

  it('converts CoCo JSON exports into the official migration payload', async () => {
    const dir = tempDir()
    const userData = path.join(dir, 'userData')
    const localStorageFile = path.join(dir, 'localStorage.json')
    const indexedDbFile = path.join(dir, 'indexedDB.json')
    fs.writeFileSync(
      localStorageFile,
      JSON.stringify({
        'persist:cherry-studio': JSON.stringify({
          settings: JSON.stringify({ language: 'zh-CN' }),
          assistants: JSON.stringify([{ id: 'assistant-1' }])
        }),
        theme: JSON.stringify('dark')
      })
    )
    fs.writeFileSync(
      indexedDbFile,
      JSON.stringify({
        version: 100,
        stores: {
          topics: [{ id: 'topic-1', messages: [] }],
          message_blocks: [{ id: 'block-1', messageId: 'message-1' }],
          metadata: { ignored: true }
        }
      })
    )

    const payload = await prepareCocoLegacyMigrationPayload({ localStorageFile, indexedDbFile }, userData)

    expect(payload.reduxData).toEqual({
      settings: { language: 'zh-CN' },
      assistants: [{ id: 'assistant-1' }]
    })
    expect(JSON.parse(fs.readFileSync(path.join(payload.dexieExportPath, 'topics.json'), 'utf-8'))).toEqual([
      { id: 'topic-1', messages: [] }
    ])
    expect(fs.existsSync(path.join(payload.dexieExportPath, 'metadata.json'))).toBe(false)
    expect(JSON.parse(fs.readFileSync(payload.localStorageExportPath!, 'utf-8'))).toContainEqual({
      key: 'theme',
      value: 'dark'
    })
  })
})
