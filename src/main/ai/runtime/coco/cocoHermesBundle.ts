import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import { loggerService } from '@logger'
import { app } from 'electron'
import { createExtractorFromFile } from 'node-unrar-js'

const logger = loggerService.withContext('CocoHermesBundle')

export const COCO_HERMES_VERSION = '0.21.0'
export const DEFAULT_COCO_HERMES_ARCHIVE = 'J:\\vfxtools\\piplineTD\\models\\packages\\hermes-agent-0.21.0.rar'

interface BundleMarker {
  version: string
  archiveSize: number
  archiveMtimeMs: number
}

export interface CocoHermesBundle {
  source: string
  runner: string
  requirements: string
}

let pendingBundle: Promise<CocoHermesBundle> | null = null
let readyBundle: CocoHermesBundle | null = null

function archivePath(): string {
  return process.env.CHERRY_HERMES_ARCHIVE?.trim() || DEFAULT_COCO_HERMES_ARCHIVE
}

function runtimeRoot(): string {
  return path.join(app.getPath('userData'), 'hermes-coco', 'runtime')
}

function bundlePaths(versionDir: string): CocoHermesBundle {
  const source = path.join(versionDir, 'hermes-agent')
  return {
    source,
    runner: path.join(source, 'coco_runtime', 'runner.py'),
    requirements: path.join(source, 'coco_runtime', 'requirements.txt')
  }
}

function isRuntimeReady(versionDir: string): boolean {
  const bundle = bundlePaths(versionDir)
  return (
    fs.existsSync(path.join(bundle.source, 'run_agent.py')) &&
    fs.existsSync(bundle.runner) &&
    fs.existsSync(bundle.requirements)
  )
}

async function readMarker(versionDir: string): Promise<BundleMarker | null> {
  try {
    return JSON.parse(await fsp.readFile(path.join(versionDir, 'bundle.json'), 'utf8')) as BundleMarker
  } catch {
    return null
  }
}

function safeArchiveEntry(filename: string): boolean {
  const normalized = filename.replace(/\\/g, '/')
  return (
    normalized === 'hermes-agent' ||
    (normalized.startsWith('hermes-agent/') &&
      !normalized.startsWith('/') &&
      !normalized.split('/').some((part) => part === '..'))
  )
}

async function extractBundle(sharedArchive: string, archiveStat: fs.Stats): Promise<CocoHermesBundle> {
  const root = runtimeRoot()
  const versionDir = path.join(root, COCO_HERMES_VERSION)
  const staging = path.join(root, `.staging-${COCO_HERMES_VERSION}-${process.pid}`)
  const backup = path.join(root, `.previous-${COCO_HERMES_VERSION}`)
  const localArchive = path.join(root, `.hermes-agent-${COCO_HERMES_VERSION}-${process.pid}.rar`)
  await fsp.mkdir(root, { recursive: true })
  await Promise.all([
    fsp.rm(staging, { recursive: true, force: true }),
    fsp.rm(backup, { recursive: true, force: true }),
    fsp.rm(localArchive, { force: true })
  ])

  try {
    // Copy first: extracting directly from a network share makes a temporary
    // disconnect look like archive corruption and holds the share open longer.
    await fsp.copyFile(sharedArchive, localArchive)
    await fsp.mkdir(staging, { recursive: true })
    const extractor = await createExtractorFromFile({ filepath: localArchive, targetPath: staging })
    const listing = extractor.getFileList()
    const headers = [...listing.fileHeaders]
    if (headers.length === 0 || headers.some((header) => !safeArchiveEntry(header.name))) {
      throw new Error('Hermes RAR contains an empty or unsafe file layout')
    }
    // node-unrar-js iterators are lazy; exhaust the result to perform all
    // extraction and release the underlying WASM/C++ extractor.
    for (const file of extractor.extract().files) {
      void file
    }
    if (!isRuntimeReady(staging)) {
      throw new Error('Hermes RAR is missing its SDK, Coco runner, or requirements')
    }
    const marker: BundleMarker = {
      version: COCO_HERMES_VERSION,
      archiveSize: archiveStat.size,
      archiveMtimeMs: archiveStat.mtimeMs
    }
    await fsp.writeFile(path.join(staging, 'bundle.json'), JSON.stringify(marker), 'utf8')
    if (fs.existsSync(versionDir)) await fsp.rename(versionDir, backup)
    await fsp.rename(staging, versionDir)
    await fsp.rm(backup, { recursive: true, force: true })
    return bundlePaths(versionDir)
  } catch (error) {
    if (!fs.existsSync(versionDir) && fs.existsSync(backup)) {
      await fsp.rename(backup, versionDir).catch(() => undefined)
    }
    throw error
  } finally {
    await Promise.all([fsp.rm(staging, { recursive: true, force: true }), fsp.rm(localArchive, { force: true })])
  }
}

async function ensureBundleImpl(): Promise<CocoHermesBundle> {
  const versionDir = path.join(runtimeRoot(), COCO_HERMES_VERSION)
  const installedBundle = bundlePaths(versionDir)
  const sharedArchive = archivePath()
  let archiveStat: fs.Stats
  try {
    archiveStat = await fsp.stat(sharedArchive)
  } catch (error) {
    if (isRuntimeReady(versionDir)) {
      logger.warn('Hermes archive unavailable; using synchronized local copy', {
        archive: sharedArchive,
        error: error instanceof Error ? error.message : String(error)
      })
      return installedBundle
    }
    throw new Error(`Hermes Agent archive is unavailable: ${sharedArchive}`)
  }

  const marker = await readMarker(versionDir)
  if (
    isRuntimeReady(versionDir) &&
    marker?.version === COCO_HERMES_VERSION &&
    marker.archiveSize === archiveStat.size &&
    marker.archiveMtimeMs === archiveStat.mtimeMs
  ) {
    return installedBundle
  }
  logger.info('Synchronizing local Hermes Agent bundle', {
    version: COCO_HERMES_VERSION,
    archive: sharedArchive
  })
  return extractBundle(sharedArchive, archiveStat)
}

export function ensureCocoHermesBundle(): Promise<CocoHermesBundle> {
  if (readyBundle) return Promise.resolve(readyBundle)
  if (!pendingBundle) {
    pendingBundle = ensureBundleImpl()
      .then((source) => {
        readyBundle = source
        return source
      })
      .finally(() => {
        pendingBundle = null
      })
  }
  return pendingBundle
}
