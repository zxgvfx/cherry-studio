import { preferenceService } from '@data/PreferenceService'
import { DataApiDevtools } from '@data/utils/dataApiDevtools'
import { initI18n } from '@renderer/i18n/resolver'
import type { UnifiedPreferenceKeyType } from '@shared/data/preference/preferenceTypes'

interface PrepareWindowOptions {
  /** Preference keys the first frame reads — 'all' warms the entire cache. */
  preference: 'all' | UnifiedPreferenceKeyType[]
  /**
   * Cap how long preference preload may block first paint. i18n still always
   * finishes first — rendering before `initI18n()` makes `t()` / `changeLanguage`
   * throw `Cannot read properties of undefined (reading 'toResolveHierarchy')`.
   */
  preferenceTimeoutMs?: number
}

/**
 * Shared entry-point prologue: every window's `entryPoint.tsx` awaits this before
 * `createRoot().render()` so the first frame reads i18n and preferences from a warm
 * cache instead of falling back to defaults (the source of the theme flash, A2).
 *
 * Both preference paths are best-effort and never reject — a failed warm-up degrades
 * to defaults plus lazy per-key self-heal in `usePreference`.
 */
export async function prepareWindow(options: PrepareWindowOptions): Promise<void> {
  // Window-scoped dev bootstrap: expose the DataApi DevTools control surface
  // before the first render (and thus the first DataApi request) so payload
  // capture can be enabled before any event is recorded. No-op in production.
  DataApiDevtools.exposeControlSurface()

  const preferencesWarm =
    options.preference === 'all' ? preferenceService.preloadAll() : preferenceService.preload(options.preference)
  const prefs =
    options.preferenceTimeoutMs && options.preferenceTimeoutMs > 0
      ? Promise.race([
          preferencesWarm,
          new Promise<void>((resolve) => window.setTimeout(resolve, options.preferenceTimeoutMs))
        ])
      : preferencesWarm

  await Promise.all([initI18n(), prefs])
}
