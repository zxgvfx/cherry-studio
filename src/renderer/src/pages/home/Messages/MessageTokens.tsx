// import { useRuntime } from '@renderer/hooks/useRuntime'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Message } from '@renderer/types/newMessage'
import { Popover } from 'antd'
import { t } from 'i18next'
import styled from 'styled-components'

interface MessageTokensProps {
  message: Message
  isLastMessage?: boolean
}

const MessageTokens: React.FC<MessageTokensProps> = ({ message }) => {
  // const { generating } = useRuntime()
  const locateMessage = () => {
    EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id, false)
  }

  const getPrice = () => {
    // Actual money cost reported by the gateway (OpenRouter usage.cost, or a
    // centralized NewAPI provider resolved via /api/log/self). Prefer it over
    // any local token-based estimate.
    if (message?.usage?.cost !== undefined) {
      return message.usage.cost
    }

    const inputTokens = message?.usage?.prompt_tokens ?? 0
    const outputTokens = message?.usage?.completion_tokens ?? 0
    const model = message.model

    if (!model || model.pricing?.input_per_million_tokens === 0 || model.pricing?.output_per_million_tokens === 0) {
      return 0
    }
    return (
      (inputTokens * (model.pricing?.input_per_million_tokens ?? 0) +
        outputTokens * (model.pricing?.output_per_million_tokens ?? 0)) /
      1000000
    )
  }

  const getPriceString = () => {
    const price = getPrice()
    if (!price || price <= 0) {
      return ''
    }
    const currencySymbol = message.usage?.cost_currency || message.model?.pricing?.currencySymbol || '$'
    return `| ${t('models.price.cost')}: ${currencySymbol}${price.toFixed(6)}`
  }

  if (!message.usage) {
    return null
  }

  if (message.role === 'user') {
    return (
      <MessageMetadata className="message-tokens" onClick={locateMessage}>
        {`Tokens: ${message?.usage?.total_tokens}`}
      </MessageMetadata>
    )
  }

  if (message.role === 'assistant') {
    let metrixs = ''
    let hasMetrics = false
    const cachedTokens = message.usage.prompt_tokens_details?.cached_tokens ?? 0
    if (message?.metrics?.completion_tokens && message?.metrics?.time_completion_millsec) {
      hasMetrics = true
      metrixs = t('settings.messages.metrics', {
        time_first_token_millsec: message?.metrics?.time_first_token_millsec,
        token_speed: (message?.metrics?.completion_tokens / (message?.metrics?.time_completion_millsec / 1000)).toFixed(
          0
        )
      })
    }

    const tokensInfo = (
      <span className="tokens">
        Tokens:
        <span>{message?.usage?.total_tokens}</span>
        <span>↑{message?.usage?.prompt_tokens}</span>
        {cachedTokens > 0 && <span>{t('settings.messages.cache_hit', { count: cachedTokens })}</span>}
        <span>↓{message?.usage?.completion_tokens}</span>
        <span>{getPriceString()}</span>
      </span>
    )

    return (
      <MessageMetadata className="message-tokens" onClick={locateMessage}>
        {hasMetrics ? (
          <Popover content={metrixs} placement="top" trigger="hover" styles={{ root: { fontSize: 11 } }}>
            {tokensInfo}
          </Popover>
        ) : (
          tokensInfo
        )}
      </MessageMetadata>
    )
  }

  return null
}

const MessageMetadata = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
  user-select: text;
  cursor: pointer;
  text-align: right;

  .tokens span {
    padding: 0 2px;
  }
`

export default MessageTokens
