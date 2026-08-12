import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { StartMigrationPayload } from '@shared/data/migration/v2/types'

const REDUX_PERSIST_KEY = 'persist:cherry-studio'

interface CocoIndexedDbExport {
  stores?: Record<string, unknown>
}

export interface CocoLegacySource {
  localStorageFile: string
  indexedDbFile: string
}

function usableFile(value: string | undefined): value is string {
  if (!value) return false
  try {
    return fs.statSync(value).isFile()
  } catch {
    return false
  }
}

export function resolveCocoLegacySource(): CocoLegacySource | null {
  const localStorageFile = process.env.CHERRY_HEADLESS_LEGACY_LOCAL_STORAGE?.trim()
  const indexedDbFile = process.env.CHERRY_HEADLESS_LEGACY_INDEXED_DB?.trim()
  if (!usableFile(localStorageFile) || !usableFile(indexedDbFile)) return null
  return { localStorageFile, indexedDbFile }
}

function parseJsonObject(raw: string, sourceName: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${sourceName} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

function parseStoredValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function extractReduxData(localStorage: Record<string, unknown>): Record<string, unknown> {
  const persisted = localStorage[REDUX_PERSIST_KEY]
  if (typeof persisted !== 'string') return {}
  const root = parseJsonObject(persisted, REDUX_PERSIST_KEY)
  return Object.fromEntries(Object.entries(root).map(([key, value]) => [key, parseStoredValue(value)]))
}

export async function prepareCocoLegacyMigrationPayload(
  source: CocoLegacySource,
  userDataPath: string
): Promise<StartMigrationPayload> {
  const [localStorageRaw, indexedDbRaw] = await Promise.all([
    fsp.readFile(source.localStorageFile, 'utf-8'),
    fsp.readFile(source.indexedDbFile, 'utf-8')
  ])
  const localStorage = parseJsonObject(localStorageRaw, source.localStorageFile)
  const indexedDb = JSON.parse(indexedDbRaw) as CocoIndexedDbExport
  if (typeof indexedDb !== 'object' || indexedDb === null || typeof indexedDb.stores !== 'object') {
    throw new Error(`${source.indexedDbFile} does not contain an IndexedDB stores object`)
  }

  const exportBasePath = path.join(userDataPath, 'migration_temp', 'coco_legacy')
  const dexieExportPath = path.join(exportBasePath, 'dexie_export')
  const localStorageExportPath = path.join(exportBasePath, 'localstorage_export', 'localStorage.json')
  await fsp.rm(exportBasePath, { recursive: true, force: true })
  await Promise.all([
    fsp.mkdir(dexieExportPath, { recursive: true }),
    fsp.mkdir(path.dirname(localStorageExportPath), { recursive: true })
  ])

  await Promise.all(
    Object.entries(indexedDb.stores).map(async ([tableName, records]) => {
      if (!Array.isArray(records)) return
      await fsp.writeFile(path.join(dexieExportPath, `${tableName}.json`), JSON.stringify(records), 'utf-8')
    })
  )

  const localStorageRecords = Object.entries(localStorage).map(([key, value]) => ({
    key,
    value: parseStoredValue(value)
  }))
  await fsp.writeFile(localStorageExportPath, JSON.stringify(localStorageRecords), 'utf-8')

  return {
    reduxData: extractReduxData(localStorage),
    dexieExportPath,
    localStorageExportPath
  }
}
