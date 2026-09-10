import type { LiteMentionItem } from './agentChatLiteTypes'

export type LiteMentionTrigger = {
  char: '/' | '@'
  query: string
  start: number
  end: number
}

const TRIGGER_RE = /(^|[\s\n])([/@])([^\s]*)$/

export function readLiteMentionTrigger(text: string, caret: number): LiteMentionTrigger | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)))
  const match = before.match(TRIGGER_RE)
  if (!match || match.index === undefined) return null
  const prefix = match[1]
  const char = match[2] as '/' | '@'
  const query = match[3] ?? ''
  const start = match.index + prefix.length
  return { char, query, start, end: before.length }
}

export function filterLiteMentions(items: readonly LiteMentionItem[], query: string): LiteMentionItem[] {
  const needle = query
    .trim()
    .toLowerCase()
    .replace(/^[/@]+/, '')
  if (!needle) return [...items]
  return items.filter((item) => {
    const hay =
      `${item.label} ${item.insert} ${item.description ?? ''} ${item.search ?? ''} ${item.group}`.toLowerCase()
    return hay.includes(needle)
  })
}

export function applyLiteMention(
  text: string,
  trigger: LiteMentionTrigger,
  insert: string
): { text: string; caret: number } {
  const token = insert.endsWith(' ') || insert.length === 0 ? insert : `${insert} `
  const next = `${text.slice(0, trigger.start)}${token}${text.slice(trigger.end)}`
  return { text: next, caret: trigger.start + token.length }
}

export function removeLiteMentionTrigger(text: string, trigger: LiteMentionTrigger): { text: string; caret: number } {
  const next = `${text.slice(0, trigger.start)}${text.slice(trigger.end)}`
  return { text: next, caret: trigger.start }
}
