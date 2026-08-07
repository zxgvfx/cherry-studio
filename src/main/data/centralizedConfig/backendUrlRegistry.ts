/**
 * Mutable "which Python backend to call back into" registry (Houdini/fork
 * customization).
 *
 * Why this exists instead of just reading `process.env.CHERRY_STUDIO_BACKEND_URL`
 * everywhere (as `centralizedConfigSync.ts` and `newApiCostLookup.ts` used to):
 *
 * The headless Electron process is intentionally long-lived — it's meant to
 * survive across many Python backend restarts (each CocoClient
 * open/close cycle spins up a *new* Python backend on a *new* ephemeral port;
 * see `headless_electron_manager.py`'s persistence design). `process.env` is
 * a snapshot taken once at `subprocess.Popen()` time, so
 * `CHERRY_STUDIO_BACKEND_URL` is only ever correct for the Python session
 * that happened to be running when *this* Electron process was first
 * spawned. Once that Python session exits and a new one starts on a
 * different port, every env-var read of the backend URL silently points at
 * a dead port (or, on Electron's very first boot before any Python backend
 * was up yet, may be empty) — `fetch()` then fails/aborts, and callers that
 * treat "no backend" as a soft failure (both `centralizedConfigSync.ts`'s
 * per-user API key refresh and `newApiCostLookup.ts`'s billing correction)
 * silently do nothing, forever, for the remaining lifetime of the Electron
 * process. This was the actual root cause behind a centralized-config
 * provider getting stuck with an empty/stale API key indefinitely, even
 * after `config_manager.py`'s own TTL/reload fix — the request to refresh it
 * never reached a live Python process at all.
 *
 * `headless_electron_manager.py` now calls `POST /backend-url` (handled in
 * `httpBridge.ts`) with its *current* pinned backend URL every single time
 * `start()` is invoked — including the fast path where an already-running
 * Electron process is reused — so this registry is kept up to date across
 * the Electron process's entire lifetime, and `httpBridge.ts` immediately
 * re-runs `syncCentralizedConfig()` whenever it changes.
 */

let currentBackendUrl = (process.env.CHERRY_STUDIO_BACKEND_URL || '').replace(/\/+$/, '')

export function getBackendUrl(): string {
  return currentBackendUrl
}

/** Returns true if the URL actually changed (callers use this to decide whether to re-sync). */
export function setBackendUrl(url: string | null | undefined): boolean {
  const normalized = (url || '').trim().replace(/\/+$/, '')
  if (normalized === currentBackendUrl) return false
  currentBackendUrl = normalized
  return true
}
