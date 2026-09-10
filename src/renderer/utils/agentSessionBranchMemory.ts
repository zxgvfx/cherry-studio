import { cacheService } from '@data/CacheService'

export type AgentSessionBranchMemory = Record<string, string>

const CACHE_KEY = 'ui.agent.last_used_branch_by_session'

export function resolveRememberedAgentSessionBranch(
  sessionId: string,
  memory: AgentSessionBranchMemory = cacheService.getPersist(CACHE_KEY)
): string {
  let current = sessionId
  const visited = new Set<string>()

  while (!visited.has(current)) {
    visited.add(current)
    const next = memory[current]
    if (!next || next === current) break
    current = next
  }

  return current
}

export function rememberAgentSessionBranch(parentOrRootSessionId: string, activeSessionId: string): void {
  const current = cacheService.getPersist(CACHE_KEY)
  cacheService.setPersist(CACHE_KEY, {
    ...current,
    [parentOrRootSessionId]: activeSessionId
  })
}

export function forgetAgentSessionBranch(sessionId: string): void {
  const current = cacheService.getPersist(CACHE_KEY)
  const next = Object.fromEntries(
    Object.entries(current).filter(([parentId, activeId]) => parentId !== sessionId && activeId !== sessionId)
  )
  cacheService.setPersist(CACHE_KEY, next)
}
