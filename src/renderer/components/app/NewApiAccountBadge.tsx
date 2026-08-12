import { HoverCard, HoverCardContent, HoverCardTrigger } from '@cherrystudio/ui'
import { Wallet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

/**
 * Real-time NewAPI account balance/spend badge (Houdini/fork customization).
 *
 * Ports the pre-v2.0 `NewApiAccountBadge` (see old
 * `cherrystudio/public/assets/index-*.js` bundle, `NewApiAccountService`),
 * adapted to the v2.0 generic `ipcApi` transport (`config.getAccountSummary`,
 * wired end-to-end in `web/src/main/headless/httpBridge.ts` →
 * `cherrystudio/backend/routes/newapi_cost.py`).
 *
 * This is deliberately independent from v2.0's own "Usage Settings" cost
 * column (`AiUsageRecordService`, a *local estimate* from a static per-model
 * price table): this badge shows what NewAPI itself reports for the
 * Houdini/OS user's provisioned wallet — real balance and cumulative spend,
 * unaffected by any client-side pricing table drift.
 *
 * Renders nothing when no centralized/provisioned NewAPI account is
 * reachable (non-Houdini deployments, or the lookup failing) — this must
 * stay invisible rather than show an error state for a feature most users
 * don't have.
 */

const NEWAPI_ACCOUNT_PROVIDER_ID = 'coco-vapi'
const REFRESH_MS = 60_000

interface AccountSummary {
  username: string
  balance: number | null
  spent: number
  currency: string
  unlimitedQuota: boolean
  requestCount: number
}

interface AccountSummaryPayload {
  ok?: boolean
  username?: string
  balance?: number | null
  spent?: number
  currency?: string
  unlimitedQuota?: boolean
  requestCount?: number
}

/**
 * `window.api.ipcApi.request` is the generic v2.0 RPC transport
 * (`IpcApi_Request` → `IpcRouter.dispatch`, see `web/src/preload/ipc.ts`):
 * every successful call is wrapped as `{ ok: true, data: <payload> }`
 * regardless of what the underlying route handler returns, and the Houdini
 * headless bridge's `dispatchForkConfigRoute` (`httpBridge.ts`) preserves
 * that same envelope for `config.*` routes. The actual account-summary
 * fields live one level down at `.data`, not on the envelope itself.
 */
interface IpcApiEnvelope {
  ok?: boolean
  data?: AccountSummaryPayload
}

function formatMoney(amount: number, currency: string): string {
  if (amount >= 1) return `${currency}${amount.toFixed(2)}`
  if (amount >= 0.01) return `${currency}${amount.toFixed(4)}`
  return `${currency}${amount.toFixed(6)}`
}

async function fetchAccountSummary(providerId: string): Promise<AccountSummary | null> {
  try {
    const envelope = (await window.api.ipcApi.request('config.getAccountSummary', {
      providerId
    })) as IpcApiEnvelope | null
    const raw = envelope?.data
    if (!envelope?.ok || !raw?.ok || typeof raw.spent !== 'number') return null
    return {
      username: raw.username || '',
      balance: raw.balance ?? null,
      spent: raw.spent,
      currency: raw.currency || '¥',
      unlimitedQuota: Boolean(raw.unlimitedQuota),
      requestCount: raw.requestCount || 0
    }
  } catch {
    return null
  }
}

export function NewApiAccountBadge() {
  const [summary, setSummary] = useState<AccountSummary | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSummary(await fetchAccountSummary(NEWAPI_ACCOUNT_PROVIDER_ID))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  if (!summary) return null

  const balanceLabel = summary.unlimitedQuota
    ? '无限'
    : summary.balance != null
      ? formatMoney(summary.balance, summary.currency)
      : '—'

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          title="账户余额"
          onClick={() => void refresh()}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-[8px] bg-background-subtle px-2.5 text-[11px] text-muted-foreground transition-colors [-webkit-app-region:no-drag] hover:bg-accent hover:text-foreground">
          <Wallet size={13} strokeWidth={1.8} />
          <span className="whitespace-nowrap">
            已用 {formatMoney(summary.spent, summary.currency)}
            <span className="mx-1.5 opacity-35">|</span>
            <span className="font-medium">余额 {balanceLabel}</span>
          </span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-64 text-xs">
        <div className="mb-2 text-[11px] text-muted-foreground">按 NewAPI 账户统计</div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">用户</span>
            <span className="font-medium">{summary.username || '—'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">账户累计花费</span>
            <span className="font-medium">{formatMoney(summary.spent, summary.currency)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">账户余额</span>
            <span className="font-medium">{balanceLabel}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">请求次数</span>
            <span>{summary.requestCount}</span>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-1 self-start text-[11px] text-primary hover:underline">
            {loading ? '刷新中…' : '点击刷新'}
          </button>
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
