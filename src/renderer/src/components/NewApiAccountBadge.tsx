import {
  fetchNewApiAccountSummary,
  NEWAPI_ACCOUNT_PROVIDER_ID,
  type NewApiAccountSummary
} from '@renderer/services/NewApiAccountService'
import { Popover } from 'antd'
import { Wallet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import styled from 'styled-components'

const PROVIDER_ID = NEWAPI_ACCOUNT_PROVIDER_ID
const REFRESH_MS = 60_000

function formatMoney(amount: number, currency: string): string {
  if (amount >= 1) return `${currency}${amount.toFixed(2)}`
  if (amount >= 0.01) return `${currency}${amount.toFixed(4)}`
  return `${currency}${amount.toFixed(6)}`
}

const NewApiAccountBadge = () => {
  const [summary, setSummary] = useState<NewApiAccountSummary | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchNewApiAccountSummary(PROVIDER_ID)
      setSummary(data)
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

  if (!summary) {
    return null
  }

  const balanceLabel = summary.unlimitedQuota
    ? '无限'
    : summary.balance != null
      ? formatMoney(summary.balance, summary.currency)
      : '—'

  const popoverContent = (
    <DetailPanel>
      <ScopeHint>按 NewAPI 账户统计</ScopeHint>
      <DetailRow>
        <span>用户</span>
        <strong>{summary.username}</strong>
      </DetailRow>
      <DetailRow>
        <span>账户累计花费</span>
        <strong>{formatMoney(summary.spent, summary.currency)}</strong>
      </DetailRow>
      <DetailRow>
        <span>账户余额</span>
        <strong>{balanceLabel}</strong>
      </DetailRow>
      <DetailRow>
        <span>请求次数</span>
        <span>{summary.requestCount}</span>
      </DetailRow>
      <RefreshHint onClick={() => void refresh()}>{loading ? '刷新中…' : '点击刷新'}</RefreshHint>
    </DetailPanel>
  )

  return (
    <Popover content={popoverContent} placement="bottomRight" trigger="hover">
      <Badge className="nodrag" onClick={() => void refresh()} title="账户余额">
        <Wallet size={13} />
        <BadgeText>
          <span className="spent">已用 {formatMoney(summary.spent, summary.currency)}</span>
          <span className="sep">|</span>
          <span className="balance">余额 {balanceLabel}</span>
        </BadgeText>
      </Badge>
    </Popover>
  )
}

const Badge = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  margin-right: 6px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background-soft);
  color: var(--color-text-2);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  -webkit-app-region: no-drag;

  &:hover {
    color: var(--color-text-1);
    border-color: var(--color-primary);
  }
`

const BadgeText = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;

  .spent {
    color: var(--color-text-2);
  }
  .balance {
    color: var(--color-text-1);
    font-weight: 500;
  }
  .sep {
    opacity: 0.35;
  }
`

const DetailPanel = styled.div`
  min-width: 240px;
  font-size: 12px;
`

const ScopeHint = styled.div`
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--color-text-3);
`

const DetailRow = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 0;

  span:first-child {
    color: var(--color-text-3);
  }
`

const RefreshHint = styled.div`
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-3);
  text-align: center;
  cursor: pointer;

  &:hover {
    color: var(--color-primary);
  }
`

export default NewApiAccountBadge
