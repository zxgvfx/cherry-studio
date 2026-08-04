import { loggerService } from '@logger'

const logger = loggerService.withContext('NewApiCostService')

interface LastCostResponse {
  ok?: boolean
  cost?: number
  currency?: string
  quota?: number
  reason?: string
  error?: string
}

export interface RequestCost {
  cost: number
  currency: string
}

interface FetchLastRequestCostParams {
  providerId: string
  modelName?: string
  promptTokens?: number
  completionTokens?: number
  /** Unix seconds when the request started, used to match the right log entry. */
  sinceTs?: number
}

const COST_ENDPOINT = '/api/v1/newapi/last-cost'

/**
 * Resolve the exact money cost of the most recent centralized (NewAPI) request.
 *
 * The heavy lifting (reading /api/log/self with the stored access token and
 * converting quota to money) happens in the local Python backend, so the access
 * token never reaches the renderer. Returns `null` when unavailable so callers
 * can silently skip cost display.
 */
export async function fetchLastRequestCost(params: FetchLastRequestCostParams): Promise<RequestCost | null> {
  const body = {
    providerId: params.providerId,
    modelName: params.modelName,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    sinceTs: params.sinceTs
  }

  try {
    const backend = (window as any).__cherryBackend
    const backendUrl = (window as any).__CHERRY_BACKEND_URL

    let result: LastCostResponse | null = null
    if (backend?.call) {
      // Qt/Python runtime: talk to the injected local backend bridge.
      result = (await backend.call(COST_ENDPOINT, body)) as LastCostResponse
    } else if (backendUrl) {
      const resp = await fetch(`${backendUrl}${COST_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Id': (window as any).__CHERRY_SESSION_ID || ''
        },
        body: JSON.stringify(body)
      })
      result = (await resp.json()) as LastCostResponse
    } else if ((window as any).api?.config?.getLastRequestCost) {
      // Pure Electron runtime: resolve via the main process over IPC.
      result = (await (window as any).api.config.getLastRequestCost(body)) as LastCostResponse
    } else {
      return null
    }

    if (result?.ok && typeof result.cost === 'number') {
      return { cost: result.cost, currency: result.currency || '$' }
    }
    logger.info('No cost resolved for request', {
      providerId: params.providerId,
      modelName: params.modelName,
      reason: result?.reason || result?.error
    })
    return null
  } catch (error) {
    logger.warn('fetchLastRequestCost failed', error as Error)
    return null
  }
}
