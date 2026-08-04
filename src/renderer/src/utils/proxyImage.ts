/**
 * Utilities for proxying external image URLs through the local backend.
 *
 * In a Qt WebEngine environment with no direct external network access,
 * <img src="https://..."> will fail. These helpers convert external URLs
 * to base64 data URLs via the backend's /api/v1/proxy/image endpoint.
 *
 * Caching strategy (3 layers):
 *   1. In-memory Map (instant, lost on page reload)
 *   2. IndexedDB (persistent across sessions, ~unlimited storage)
 *   3. Backend disk cache (~/.cherrystudio/image-cache/, 7-day TTL)
 */

const _memCache = new Map<string, string>()
const _pending = new Map<string, Promise<string | null>>()

const IDB_NAME = 'cherry-image-cache'
const IDB_STORE = 'images'
const IDB_VERSION = 1
const IDB_MAX_AGE_MS = 7 * 24 * 3600 * 1000

let _db: IDBDatabase | null = null
let _dbReady: Promise<IDBDatabase | null> | null = null

function _openDB(): Promise<IDBDatabase | null> {
  if (_dbReady) return _dbReady
  _dbReady = new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE)
        }
      }
      req.onsuccess = () => {
        _db = req.result
        resolve(_db)
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return _dbReady
}

function _idbGet(key: string): Promise<{ dataUrl: string; ts: number } | null> {
  return new Promise(async (resolve) => {
    try {
      const db = await _openDB()
      if (!db) return resolve(null)
      const tx = db.transaction(IDB_STORE, 'readonly')
      const store = tx.objectStore(IDB_STORE)
      const req = store.get(key)
      req.onsuccess = () => {
        const val = req.result
        if (val && Date.now() - val.ts < IDB_MAX_AGE_MS) {
          resolve(val)
        } else {
          resolve(null)
        }
      }
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

function _idbPut(key: string, dataUrl: string): void {
  _openDB().then((db) => {
    if (!db) return
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put({ dataUrl, ts: Date.now() }, key)
    } catch {
      // ignore write failures
    }
  })
}

export function isExternalUrl(url: string): boolean {
  if (!url) return false
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file://')) {
    return false
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    try {
      const parsed = new URL(url)
      const hostname = parsed.hostname
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
        return false
      }
    } catch {
      // malformed URL, treat as external
    }
    return true
  }
  return false
}

export function isLocalFileUrl(url: string): boolean {
  return !!url && url.startsWith('file://')
}

/**
 * Convert an external URL to a base64 data URL via the backend proxy.
 * Checks memory cache → IndexedDB → backend (which has its own disk cache).
 */
export async function proxyImageUrl(url: string): Promise<string | null> {
  if (!url || !isExternalUrl(url)) return url || null
  return _cachedProxy(url, _doProxy)
}

/**
 * Convert a file:// URL to a base64 data URL via the backend.
 * Qt WebEngine blocks file:// resources, so we read through the backend instead.
 */
export async function proxyLocalFileUrl(url: string): Promise<string | null> {
  if (!url || !isLocalFileUrl(url)) return url || null
  return _cachedProxy(url, _doLocalFileProxy)
}

async function _cachedProxy(url: string, fetchFn: (url: string) => Promise<string | null>): Promise<string | null> {
  const memHit = _memCache.get(url)
  if (memHit) return memHit

  const inflight = _pending.get(url)
  if (inflight) return inflight

  const promise = (async (): Promise<string | null> => {
    const idbHit = await _idbGet(url)
    if (idbHit) {
      _memCache.set(url, idbHit.dataUrl)
      return idbHit.dataUrl
    }

    const result = await fetchFn(url)
    if (result) {
      _memCache.set(url, result)
      _idbPut(url, result)
    }
    return result
  })()

  _pending.set(url, promise)
  try {
    return await promise
  } finally {
    _pending.delete(url)
  }
}

async function _doProxy(url: string): Promise<string | null> {
  try {
    const api = (window as any).api
    if (api?.proxyImage) {
      const dataUrl = await api.proxyImage(url)
      if (dataUrl) return dataUrl
    }

    const resp = await fetch(url)
    if (!resp.ok) return null
    const blob = await resp.blob()
    return await blobToDataUrl(blob)
  } catch (e) {
    console.error('[proxyImage] failed for', url, e)
    return null
  }
}

async function _doLocalFileProxy(fileUrl: string): Promise<string | null> {
  try {
    let filePath = fileUrl
    if (fileUrl.startsWith('file:///')) {
      filePath = decodeURIComponent(fileUrl.slice(8))
    } else if (fileUrl.startsWith('file://')) {
      filePath = decodeURIComponent(fileUrl.slice(7))
    }
    const normalized = filePath.replace(/\\/g, '/')

    const api = (window as any).api
    if (api?.file?.binaryImage) {
      // FileManager / Qt API expect `id.ext` under app data, not a full absolute path.
      const baseName = normalized.split('/').pop()
      if (baseName && baseName.includes('.')) {
        const byName = await api.file.binaryImage(baseName)
        if (byName?.data) return byName.data
      }
      const result = await api.file.binaryImage(normalized)
      if (result?.data) return result.data
    }

    const backendUrl = (window as any).__CHERRY_BACKEND_URL || ''
    if (backendUrl) {
      const resp = await fetch(backendUrl + '/api/v1/files/binary-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: normalized })
      })
      if (!resp.ok) return null
      const data = await resp.json()
      if (data?.data) return data.data
    }

    return null
  } catch (e) {
    console.error('[proxyImage] local file proxy failed:', fileUrl, e)
    return null
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error || new Error('blob read failed'))
    reader.readAsDataURL(blob)
  })
}

/**
 * If the given URL is external, proxy it and return a data URL.
 * Otherwise return the original URL unchanged.
 */
export async function ensureLocalImageUrl(url: string): Promise<string> {
  if (!isExternalUrl(url)) return url
  const proxied = await proxyImageUrl(url)
  return proxied || url
}
