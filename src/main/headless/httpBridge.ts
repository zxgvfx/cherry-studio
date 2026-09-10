/**
 * Headless HTTP bridge — the only Houdini-specific addition to the main
 * process. Only ever started when `CHERRY_HEADLESS=1` (see `main.ts`), i.e.
 * this Electron main process is running as a windowless background service
 * launched by the Python/Qt host instead of a normal desktop app.
 *
 * Exposes the SAME business logic the renderer normally reaches over
 * `ipcApi`/`dataApi` (`IpcRouter` / `ApiServer` — both already transport
 * agnostic by design, see `IpcRouter.ts` / `ApiServer.ts`), over plain HTTP so
 * a non-Electron process (Python) can call it. `ai.stream.*` gets dedicated
 * SSE endpoints because the real `ai.stream.*` ipcApi handlers require a live
 * `Electron.WebContents` (see `ipc/handlers/ai.ts`); here we hand
 * `AiStreamManager` a plain `StreamListener` that writes SSE frames straight
 * to the HTTP response instead, the same pattern the API Gateway's
 * `SseListener` already uses for its own headless-style streaming.
 *
 * Deliberately NOT using Elysia (unlike ApiGatewayService) to avoid coupling
 * this bridge's lifecycle to that service — this is plumbing, not a feature,
 * and Node's `http` module is enough for a handful of routes.
 */

import { application } from '@application'
import { loggerService } from '@logger'
import { projectStreamChunkForRenderer } from '@main/utils/messageOutputProjection'
import type { AiStreamAbortRequest, AiStreamOpenRequest } from '@shared/ai/transport'
import type { DataRequest } from '@shared/data/api/types'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { createInternalEntryInputSchema } from '@shared/ipc/schemas/file'
import { ipcRequestSchemas } from '@shared/ipc/schemas/ipcSchemas'
import { randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'

import type { StreamListener } from '../ai/streamManager'
import { ApiServer } from '../data/api'
import { getBackendUrl, setBackendUrl } from '../data/centralizedConfig/backendUrlRegistry'
import { syncCentralizedConfig } from '../data/centralizedConfig/centralizedConfigSync'
import { ipcHandlers } from '../ipc/handlers/ipcHandlers'
import { IpcRouter } from '../ipc/IpcRouter'
import { EnsureExternalEntryIpcSchema } from '../services/file'
import { publishHeadlessEvent, setHeadlessEventPublisher } from './eventBus'
import { StreamChunkCoalescer } from './StreamChunkCoalescer'

const logger = loggerService.withContext('HeadlessHttpBridge')

const DEFAULT_PORT = 34115
const eventClients = new Set<ServerResponse>()

// Same router IpcApiService builds internally — reconstructed here since the
// real one binds itself to `ipcMain`, which does not exist meaningfully for
// requests coming from outside Electron's IPC layer.
const ipcRouter = new IpcRouter(ipcRequestSchemas, ipcHandlers)
const forkConfigRoutes = new Set([
  'config.getMergedConfig',
  'config.reload',
  'config.updateUserModels',
  'config.updateUserMcpServers',
  'config.getLastRequestCost',
  'config.getAccountSummary'
])

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf-8')
  if (!raw) return undefined
  return JSON.parse(raw)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function publishToEventClients(event: string, payload: unknown): void {
  const frame = `data: ${JSON.stringify({ event, payload })}\n\n`
  for (const client of eventClients) {
    try {
      client.write(frame)
    } catch {
      eventClients.delete(client)
    }
  }
}

function handleEvents(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  eventClients.add(res)
  logger.debug('/events client connected', { totalClients: eventClients.size })
  res.write(': connected\n\n')
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      clearInterval(heartbeat)
      eventClients.delete(res)
    }
  }, 20_000)
  res.on('close', () => {
    clearInterval(heartbeat)
    eventClients.delete(res)
    logger.debug('/events client disconnected', { totalClients: eventClients.size })
  })
}

async function dispatchForkConfigRoute(route: string, input: unknown): Promise<unknown> {
  // Houdini/fork customization: use the live backendUrlRegistry (kept fresh
  // via POST /backend-url on every headless_electron_manager.py start/reuse)
  // instead of process.env.CHERRY_STUDIO_BACKEND_URL — that's a one-time
  // snapshot from this process's original Popen() call and goes stale the
  // moment the Python backend restarts on a new ephemeral port, which is
  // exactly what broke both the "regenerate"/config.reload button and the
  // NewAPI account-summary/last-cost lookups from the renderer.
  const backendUrl = getBackendUrl().replace(/\/$/, '')
  if (!backendUrl) throw new Error('CHERRY_STUDIO_BACKEND_URL is not configured')

  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const definitions: Record<string, { path: string; method: 'GET' | 'POST'; body?: unknown }> = {
    'config.getMergedConfig': { path: '/api/v1/config/merged', method: 'GET' },
    'config.reload': { path: '/api/v1/config/reload', method: 'POST', body: {} },
    'config.updateUserModels': {
      path: '/api/v1/config/update-models',
      method: 'POST',
      body: { models: Array.isArray(value.models) ? value.models : Array.isArray(input) ? input : [] }
    },
    'config.updateUserMcpServers': {
      path: '/api/v1/config/update-mcp-servers',
      method: 'POST',
      body: { servers: Array.isArray(value.servers) ? value.servers : Array.isArray(input) ? input : [] }
    },
    'config.getLastRequestCost': { path: '/api/v1/newapi/last-cost', method: 'POST', body: value },
    'config.getAccountSummary': { path: '/api/v1/newapi/account-summary', method: 'POST', body: value }
  }
  const definition = definitions[route]
  const response = await fetch(`${backendUrl}${definition.path}`, {
    method: definition.method,
    headers: definition.method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
    body: definition.method === 'POST' ? JSON.stringify(definition.body ?? {}) : undefined
  })
  const data = await response.json()
  if (!response.ok) throw new Error(`Python backend ${definition.path} failed (${response.status})`)
  return data
}

/** The whole `ai.stream.*` family bypasses the schema-validated generic IpcRouter — `open`/`attach`
 * need a real StreamListener wired to this HTTP response (which the generic bridge can't build),
 * and `detach`/`abort` need the headless listener id (`headless:...`), not a `WebContents`-derived
 * one, so routing them generically would silently no-op instead of erroring. */
const AI_STREAM_ROUTES = new Set(['ai.stream.open', 'ai.stream.attach', 'ai.stream.detach', 'ai.stream.abort'])

async function handleIpcApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { route?: string; input?: unknown }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  const { route, input } = body ?? {}
  if (!route || typeof route !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing route' } })
    return
  }
  if (AI_STREAM_ROUTES.has(route)) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'USE_STREAM_ENDPOINT', message: `${route} must go through /ai-stream/*` }
    })
    return
  }
  try {
    if (forkConfigRoutes.has(route)) {
      const data = await dispatchForkConfigRoute(route, input)
      sendJson(res, 200, { ok: true, data })
      return
    }
    const data = await ipcRouter.dispatch(route, input, { senderId: null })
    sendJson(res, 200, { ok: true, data })
  } catch (e) {
    logger.warn(`ipc-api route failed: ${route}`, e as Error)
    sendJson(res, 200, { ok: false, error: IpcError.from(e).toJSON() })
  }
}

/**
 * Preference relay — `PreferenceService`'s IPC channels (`Preference_Get` etc.)
 * are registered directly on `ipcMain.handle`, not through the generic
 * `ipcHandlers`/`IpcRouter` map `/ipc-api` dispatches to, so they need their
 * own routes here (same reasoning as the `ai.stream.*` family above).
 *
 * Routing preference reads/writes through the real `PreferenceService`
 * (backed by `DefaultPreferences.default`, see `PreferenceService.get`) is
 * the whole point: it is the single source of truth every other main-process
 * service already reads through `application.get('PreferenceService')`, and
 * — critically — it returns the schema default for an unset key instead of a
 * bare `null` (a Python-side JSON-file stand-in returning raw `None` for a
 * missing key is indistinguishable from "loaded empty value" to the renderer's
 * `usePreference` hook, which only falls back to the default when the raw
 * value is `undefined`).
 */
async function handlePreferenceGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { key?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!body?.key || typeof body.key !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing key' } })
    return
  }
  try {
    const data = application.get('PreferenceService').get(body.key as never)
    sendJson(res, 200, { ok: true, data })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
  }
}

async function handlePreferenceGetMultiple(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { keys?: string[] }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  const keys = Array.isArray(body?.keys) ? body.keys : []
  try {
    const data = application.get('PreferenceService').getMultipleRaw(keys as never[])
    sendJson(res, 200, { ok: true, data })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
  }
}

async function handlePreferenceGetAll(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const data = application.get('PreferenceService').getAll()
    sendJson(res, 200, { ok: true, data })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
  }
}

async function handlePreferenceSet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { key?: string; value?: unknown }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!body?.key || typeof body.key !== 'string') {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing key' } })
    return
  }
  try {
    await application.get('PreferenceService').set(body.key as never, body.value as never)
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
  }
}

async function handlePreferenceSetMultiple(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { updates?: Record<string, unknown> }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  try {
    await application.get('PreferenceService').setMultiple((body?.updates ?? {}) as never)
    sendJson(res, 200, { ok: true })
  } catch (e) {
    sendJson(res, 200, { ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } })
  }
}

/**
 * `POST /backend-url { url }` — called by `headless_electron_manager.py` on
 * *every* `start()` (including the "already running, reuse it" fast path),
 * not just fresh spawns. See `backendUrlRegistry.ts` for why a one-shot env
 * var isn't enough for a long-lived Electron process talking to a
 * short-lived-per-session Python backend.
 *
 * Always re-runs `syncCentralizedConfig()` here, even when `changed` is
 * false — NOT just when the URL string differs from before. Reasoning: the
 * boot-time sync in `main.ts` races against the Python backend actually
 * being ready to accept HTTP requests (Python calls `mgr.start()` for this
 * Electron process, but that doesn't guarantee its *own* `/api/v1/config`
 * server was already listening at the exact moment this process's very
 * first `syncCentralizedConfig()` ran during startup). If that first attempt
 * loses the race, gating the retry on "did the URL change" would mean it
 * never gets a second chance for the lifetime of this Electron process,
 * since Python keeps pushing the *same* URL for its own session. Re-running
 * unconditionally on every push costs one extra HTTP round-trip to Python
 * (cheap, and `syncCentralizedConfig()` is designed to be safe/idempotent to
 * call repeatedly) in exchange for guaranteed self-healing.
 */
async function handleBackendUrl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { url?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  const changed = setBackendUrl(body?.url)
  sendJson(res, 200, { ok: true, changed })
  logger.info('Python backend URL pushed; re-syncing centralized config', { url: body?.url, changed })
  void syncCentralizedConfig().catch((error) => {
    logger.warn('Re-sync after backend-url push failed', { error })
  })
}

/**
 * `POST /managed-proxy` is an internal localhost-only control channel used by
 * Python to install the confidential deployment proxy in the headless
 * Electron network stack. The URL is never persisted or returned.
 */
async function handleManagedProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { proxyUrl?: string; bypassRules?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (typeof body?.proxyUrl !== 'string' || !body.proxyUrl.trim()) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing managed proxy' } })
    return
  }
  try {
    await application
      .get('ProxyService')
      .setManagedProxy(body.proxyUrl, typeof body.bypassRules === 'string' ? body.bypassRules : '')
    logger.info('Managed proxy applied to the headless Electron network stack')
    sendJson(res, 200, { ok: true, managed: true })
  } catch {
    // Do not attach the underlying error: native/network errors may echo the
    // confidential URL they were given.
    logger.error('Managed proxy apply failed (configuration hidden)')
    sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Managed proxy apply failed' } })
  }
}

/**
 * Resolve a v2 FileEntry id through the real headless FileManager.
 *
 * Painting results are persisted by Electron before this call. The Qt
 * renderer still adapts them to legacy FileMetadata, so it needs the absolute
 * path stored behind the entry id.
 */
async function handleFilePhysicalPath(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { id?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (typeof body?.id !== 'string' || !body.id.trim()) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing file entry id' } })
    return
  }
  try {
    const path = application.get('FileManager').getPhysicalPath(body.id as never)
    sendJson(res, 200, { ok: true, path })
  } catch (e) {
    logger.warn('file physical-path resolution failed', e as Error)
    sendJson(res, 200, { ok: false, error: IpcError.from(e).toJSON() })
  }
}

async function handleFileCreateInternalEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const input = createInternalEntryInputSchema.parse(await readJsonBody(req))
    const entry = await application.get('FileManager').createInternalEntry(input)
    sendJson(res, 200, { ok: true, entry })
  } catch (e) {
    logger.warn('file create-internal-entry failed', e as Error)
    sendJson(res, 200, { ok: false, error: IpcError.from(e).toJSON() })
  }
}

async function handleFileEnsureExternalEntry(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const input = EnsureExternalEntryIpcSchema.parse(await readJsonBody(req))
    const entry = await application.get('FileManager').ensureExternalEntry(input)
    sendJson(res, 200, { ok: true, entry })
  } catch (e) {
    logger.warn('file ensure-external-entry failed', e as Error)
    sendJson(res, 200, { ok: false, error: IpcError.from(e).toJSON() })
  }
}

async function handleDataApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Partial<DataRequest>
  try {
    body = (await readJsonBody(req)) as Partial<DataRequest>
  } catch {
    sendJson(res, 400, { error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!body?.method || !body?.path) {
    sendJson(res, 400, { error: { code: 'BAD_REQUEST', message: 'Missing method/path' } })
    return
  }
  const request: DataRequest = { ...body, id: body.id ?? randomUUID(), method: body.method, path: body.path }
  try {
    const response = await ApiServer.getInstance().handleRequest(request)
    sendJson(res, 200, response)
  } catch (e) {
    logger.warn(`data-api request failed: ${body.method} ${body.path}`, e as Error)
    sendJson(res, 500, { id: request.id, status: 500, error: { message: e instanceof Error ? e.message : String(e) } })
  }
}

/**
 * Publishes frames to `/events` — the headless equivalent of `WebContentsListener`
 * (see `main/ai/streamManager/listeners/WebContentsListener.ts`). Frames use the same
 * `{event, payload}` shape as that listener's single-channel `wc.send(IpcChannel.IpcApi_Event,
 * event, payload)` emit, so the Python-side relay (`api/headless_electron_manager.py`) can forward them
 * to the frontend's `ipcApi.on(event, callback)` registry completely unchanged — no
 * headless-specific event names on the wire.
 *
 * Coalesces rapid text/reasoning/tool-input deltas before they cross the extra
 * Electron → Python → browser SSE hops. Long reasoning traces otherwise flood
 * Qt WebEngine with thousands of paint-triggering events and can make the host
 * appear frozen. Terminal events always flush pending text first.
 */
// Tracks the currently-registered headless SSE listener's underlying HTTP response per
// deterministic listener id (see `headlessListenerId()` below). `ai.stream.open` and
// `ai.stream.attach` for the SAME topic share one id — exactly like real desktop's
// `WebContentsListener` (`wc:<senderId>:<topicId>`) — so `AiStreamManager`'s
// `stream.listeners.set(id, ...)` naturally REPLACES the open's listener object with
// attach's rather than adding a second one (which would double-fire global
// `ai.stream.chunk` / `done` events).
//
// There is one essential headless-only wrinkle: Python waits for the first
// `open-result` SSE frame before returning the renderer's `ai.stream.open`
// promise. Agent session UI can issue `ai.stream.attach` immediately after
// `open`, before `AiStreamManager.dispatch()` has returned. Eagerly ending
// that still-pending open response then drops its acknowledgement; Python
// waits for 60 seconds and reports `open-result timed out`, even though the
// model run itself proceeds. Defer closing a superseded open response until
// its acknowledgement has been written, then close it normally.
interface HeadlessListenerConnection {
  response: ServerResponse
  awaitingOpenResult: boolean
  closeAfterOpenResult: boolean
}

const headlessListenerConnections = new Map<string, HeadlessListenerConnection>()

function headlessListenerId(topicId: string): string {
  return `headless:${topicId}`
}

function endHeadlessListenerConnection(connection: HeadlessListenerConnection): void {
  try {
    connection.response.end()
  } catch {
    // already closed
  }
}

function registerHeadlessListenerConnection(
  listenerId: string,
  res: ServerResponse,
  options: { awaitingOpenResult?: boolean } = {}
): HeadlessListenerConnection {
  const connection: HeadlessListenerConnection = {
    response: res,
    awaitingOpenResult: options.awaitingOpenResult === true,
    closeAfterOpenResult: false
  }
  const previous = headlessListenerConnections.get(listenerId)
  if (previous && previous.response !== res) {
    if (previous.awaitingOpenResult) {
      previous.closeAfterOpenResult = true
    } else {
      endHeadlessListenerConnection(previous)
    }
  }
  headlessListenerConnections.set(listenerId, connection)
  res.on('close', () => {
    if (headlessListenerConnections.get(listenerId) === connection) {
      headlessListenerConnections.delete(listenerId)
    }
  })
  return connection
}

function finishHeadlessOpenHandshake(connection: HeadlessListenerConnection, close = false): void {
  connection.awaitingOpenResult = false
  if (close || connection.closeAfterOpenResult) {
    endHeadlessListenerConnection(connection)
  }
}

function createHttpSseListener(res: ServerResponse, id: string, topicId: string): StreamListener {
  let closed = false
  const emitChunk = (
    chunk: Parameters<StreamListener['onChunk']>[0],
    sourceModelId?: Parameters<StreamListener['onChunk']>[1],
    anchorMessageId?: Parameters<StreamListener['onChunk']>[2],
    attemptId?: Parameters<StreamListener['onChunk']>[3]
  ) => {
    publishHeadlessEvent('ai.stream.chunk', {
      topicId,
      executionId: sourceModelId,
      attemptId: attemptId ?? 1,
      anchorMessageId,
      chunk: projectStreamChunkForRenderer(chunk, topicId, anchorMessageId)
    })
  }
  const coalescer = new StreamChunkCoalescer(emitChunk)
  const end = () => {
    if (closed) return
    closed = true
    coalescer.discard()
    try {
      res.end()
    } catch {
      // already closed
    }
  }
  res.on('close', () => {
    closed = true
    coalescer.discard()
  })
  return {
    id,
    onChunk: (chunk, sourceModelId, anchorMessageId, attemptId) => {
      if (!closed) coalescer.push(chunk, sourceModelId, anchorMessageId, attemptId)
    },
    onDone: (result) => {
      coalescer.flush()
      publishHeadlessEvent('ai.stream.done', {
        topicId,
        executionId: result.modelId,
        attemptId: result.attemptId ?? 1,
        ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
        anchorMessageId: result.anchorMessageId,
        status: result.status,
        isTopicDone: result.isTopicDone
      })
      end()
    },
    onPaused: (result) => {
      coalescer.flush()
      publishHeadlessEvent('ai.stream.done', {
        topicId,
        executionId: result.modelId,
        attemptId: result.attemptId ?? 1,
        ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
        anchorMessageId: result.anchorMessageId,
        status: result.status,
        isTopicDone: result.isTopicDone
      })
      end()
    },
    onError: (result) => {
      coalescer.flush()
      publishHeadlessEvent('ai.stream.error', {
        topicId,
        executionId: result.modelId,
        attemptId: result.attemptId ?? 1,
        ...(result.topicAttemptWatermark !== undefined ? { topicAttemptWatermark: result.topicAttemptWatermark } : {}),
        anchorMessageId: result.anchorMessageId,
        isTopicDone: result.isTopicDone,
        error: result.error
      })
      end()
    },
    isAlive: () => !closed
  }
}

async function handleAiStreamOpen(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let request: AiStreamOpenRequest
  try {
    request = (await readJsonBody(req)) as AiStreamOpenRequest
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!request?.topicId) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing topicId' } })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const listenerId = headlessListenerId(request.topicId)
  const connection = registerHeadlessListenerConnection(listenerId, res, { awaitingOpenResult: true })
  const listener = createHttpSseListener(res, listenerId, request.topicId)
  try {
    const openResult = await application.get('AiStreamManager').dispatch(listener, request)
    // Surface the synchronous open result (e.g. `{mode:'blocked', reason:'paused'}`) as
    // the first SSE frame — the streamed chunks (if any) follow via the listener above.
    res.write(`data: ${JSON.stringify({ type: 'open-result', result: openResult, listenerId })}\n\n`)
    finishHeadlessOpenHandshake(connection)
  } catch (e) {
    logger.error('ai.stream.open failed', e as Error)
    res.write(`data: ${JSON.stringify({ type: 'error', result: { error: String(e) } })}\n\n`)
    finishHeadlessOpenHandshake(connection, true)
  }
}

/** Reconnect an already-open topic stream — the headless counterpart of `AiStreamManager.attach()`
 * (see `ipc/handlers/ai.ts`'s `ai.stream.attach`), used after Python's SSE connection to `/ai-stream/open`
 * drops (network hiccup, headless Electron restart, etc.) so an in-flight generation isn't lost. */
async function handleAiStreamAttach(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { topicId?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!body?.topicId) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing topicId' } })
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  const listenerId = headlessListenerId(body.topicId)
  const currentConnection = headlessListenerConnections.get(listenerId)
  // The Qt bridge fans one open listener's events to every browser subscriber
  // over `/events`; a same-window attach therefore does not need to replace a
  // healthy open listener. In particular, Agent overlays attach during their
  // initial React reconciliation and may immediately detach again. Replacing
  // the open listener in that window made this transient lifecycle capable of
  // dropping tool-approval and tool-result chunks from an otherwise healthy
  // Agent turn.
  if (currentConnection && !currentConnection.response.writableEnded && !currentConnection.response.destroyed) {
    const result = { status: 'attached' as const, bufferedChunks: [] }
    res.write(`data: ${JSON.stringify({ type: 'attach-result', result, listenerId })}\n\n`)
    res.end()
    return
  }

  const listener = createHttpSseListener(res, listenerId, body.topicId)
  try {
    const result = application.get('AiStreamManager').attachListener(body.topicId, listener)
    // Only supersede the physical `/open` response after Main confirmed this
    // attach is live. During a newly-started Agent turn an eager attach can
    // race before `dispatch()` has inserted the stream; that `not-found`
    // response must not evict the still-valid open listener or its pending
    // `open-result` acknowledgement.
    if (result.status === 'attached') {
      registerHeadlessListenerConnection(listenerId, res)
    }
    res.write(`data: ${JSON.stringify({ type: 'attach-result', result, listenerId })}\n\n`)
    // A real attach keeps the SSE connection open for future chunks; every
    // other status (not-found/done/paused/error) is a one-shot reply.
    if (result.status !== 'attached') res.end()
  } catch (e) {
    logger.error('ai.stream.attach failed', e as Error)
    res.write(`data: ${JSON.stringify({ type: 'error', result: { error: String(e) } })}\n\n`)
    res.end()
  }
}

/** Removes a previously attached/opened headless SSE listener. Python calls this instead of the
 * real `ai.stream.detach` (which resolves the listener id from a `WebContents`, meaningless here). */
async function handleAiStreamDetach(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: { topicId?: string; listenerId?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!body?.topicId || !body?.listenerId) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing topicId/listenerId' } })
    return
  }
  application.get('AiStreamManager').removeListener(body.topicId, body.listenerId)
  sendJson(res, 200, { ok: true })
}

async function handleAiStreamAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: AiStreamAbortRequest & { reason?: string }
  try {
    body = (await readJsonBody(req)) as typeof body
  } catch {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: 'Invalid JSON body' } })
    return
  }
  if (!body?.topicId) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'Missing topicId' } })
    return
  }
  application.get('AiStreamManager').abort(body.topicId, body.reason ?? 'headless-bridge-abort')
  sendJson(res, 200, { ok: true })
}

export async function startHeadlessBridge(): Promise<void> {
  const port = Number(process.env.CHERRY_HEADLESS_PORT) || DEFAULT_PORT
  setHeadlessEventPublisher(publishToEventClients)
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = req.url ?? ''
        if (req.method === 'GET' && url === '/healthz') {
          sendJson(res, 200, { ok: true })
          return
        }
        if (req.method === 'GET' && url === '/events') return handleEvents(req, res)
        if (req.method === 'POST' && url === '/ipc-api') return await handleIpcApi(req, res)
        if (req.method === 'POST' && url === '/data-api') return await handleDataApi(req, res)
        if (req.method === 'POST' && url === '/preference/get') return await handlePreferenceGet(req, res)
        if (req.method === 'POST' && url === '/preference/get-multiple')
          return await handlePreferenceGetMultiple(req, res)
        if (req.method === 'POST' && url === '/preference/get-all') return await handlePreferenceGetAll(req, res)
        if (req.method === 'POST' && url === '/preference/set') return await handlePreferenceSet(req, res)
        if (req.method === 'POST' && url === '/preference/set-multiple')
          return await handlePreferenceSetMultiple(req, res)
        if (req.method === 'POST' && url === '/ai-stream/open') return await handleAiStreamOpen(req, res)
        if (req.method === 'POST' && url === '/ai-stream/attach') return await handleAiStreamAttach(req, res)
        if (req.method === 'POST' && url === '/ai-stream/detach') return await handleAiStreamDetach(req, res)
        if (req.method === 'POST' && url === '/ai-stream/abort') return await handleAiStreamAbort(req, res)
        if (req.method === 'POST' && url === '/backend-url') return await handleBackendUrl(req, res)
        if (req.method === 'POST' && url === '/managed-proxy') return await handleManagedProxy(req, res)
        if (req.method === 'POST' && url === '/file/create-internal-entry')
          return await handleFileCreateInternalEntry(req, res)
        if (req.method === 'POST' && url === '/file/ensure-external-entry')
          return await handleFileEnsureExternalEntry(req, res)
        if (req.method === 'POST' && url === '/file/physical-path') return await handleFilePhysicalPath(req, res)
        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `No such route: ${url}` } })
      } catch (e) {
        logger.error('Unhandled headless bridge error', e as Error)
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(e) } })
      }
    })()
  })

  await new Promise<void>((resolve) => {
    // 127.0.0.1 only — this bridge trusts every caller, it must never be reachable off-box.
    server.listen(port, '127.0.0.1', resolve)
  })
  logger.info(`Headless HTTP bridge listening on http://127.0.0.1:${port}`)
}
