/**
 * Embedded browsers (e.g. older Qt WebEngine in DCC hosts) may not implement
 * AbortSignal.any / AbortSignal.timeout. Patch before any network or AI code runs.
 * When native APIs exist, this module is a no-op.
 */
function installAbortSignalAny(): void {
  if (typeof AbortSignal.any === 'function') {
    return
  }
  try {
    Object.defineProperty(AbortSignal, 'any', {
      value(signals: Iterable<AbortSignal>): AbortSignal {
        const list = [...signals]
        if (list.length === 0) {
          return new AbortController().signal
        }
        const controller = new AbortController()
        for (const signal of list) {
          if (signal.aborted) {
            controller.abort(signal.reason)
            return controller.signal
          }
          signal.addEventListener('abort', () => controller.abort(signal.reason), {
            once: true,
            signal: controller.signal
          })
        }
        return controller.signal
      },
      configurable: true,
      writable: true
    })
  } catch {
    // AbortSignal may be sealed in some runtimes.
  }
}

function installAbortSignalTimeout(): void {
  if (typeof AbortSignal.timeout === 'function') {
    return
  }
  try {
    Object.defineProperty(AbortSignal, 'timeout', {
      value(ms: number): AbortSignal {
        const controller = new AbortController()
        const id = setTimeout(() => {
          controller.abort()
        }, ms)
        controller.signal.addEventListener('abort', () => clearTimeout(id), { once: true })
        return controller.signal
      },
      configurable: true,
      writable: true
    })
  } catch {
    // see installAbortSignalAny
  }
}

installAbortSignalAny()
installAbortSignalTimeout()
