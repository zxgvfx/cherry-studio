const STORAGE_PREFIX = 'coco:review-done:'

export function isReviewDismissed(runId?: string): boolean {
  if (!runId || typeof sessionStorage === 'undefined') return false
  try {
    return sessionStorage.getItem(`${STORAGE_PREFIX}${runId}`) === '1'
  } catch {
    return false
  }
}

export function markReviewDismissed(runId?: string): void {
  if (!runId || typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${runId}`, '1')
  } catch {
    /* private / quota */
  }
}
