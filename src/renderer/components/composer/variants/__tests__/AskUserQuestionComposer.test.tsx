import type { CherryMessagePart } from '@shared/data/types/message'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type * as ReactI18next from 'react-i18next'
import { describe, expect, it, vi } from 'vitest'

import AskUserQuestionComposer, { type AskUserQuestionComposerRequest } from '../AskUserQuestionComposer'

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, number>) => {
      if (key === 'agent.askUserQuestion.progress') return `${options?.current} of ${options?.total}`
      return (
        {
          'agent.askUserQuestion.close': 'Close',
          'agent.askUserQuestion.customPlaceholder': 'Enter your answer...',
          'agent.askUserQuestion.next': 'Next',
          'agent.askUserQuestion.other': 'Other',
          'agent.askUserQuestion.otherDescription': 'Type your own answer',
          'agent.askUserQuestion.previous': 'Previous',
          'agent.askUserQuestion.skip': 'Skip',
          'agent.askUserQuestion.submit': 'Submit'
        }[key] ?? key
      )
    }
  })
}))

const questions = [
  {
    question: 'Choose logger',
    header: 'Logger',
    options: [
      { label: 'Winston', description: 'Mature ecosystem' },
      { label: 'Pino', description: 'JSON native' }
    ],
    multiSelect: false
  },
  {
    question: 'Add context',
    header: 'Context',
    options: [{ label: 'Bunyan' }],
    multiSelect: false
  }
]

function makeRequest(
  requestQuestions: AskUserQuestionComposerRequest['input']['questions'] = questions
): AskUserQuestionComposerRequest {
  const part = {
    type: 'tool-AskUserQuestion',
    toolCallId: 'call-1',
    state: 'approval-requested',
    input: { questions: requestQuestions },
    approval: { id: 'approval-1' }
  } as unknown as CherryMessagePart

  return {
    messageId: 'message-1',
    toolCallId: 'call-1',
    approvalId: 'approval-1',
    input: { questions: requestQuestions },
    match: {
      part,
      state: 'approval-requested',
      toolCallId: 'call-1',
      messageId: 'message-1',
      approvalId: 'approval-1',
      input: { questions: requestQuestions }
    }
  }
}

describe('AskUserQuestionComposer', () => {
  it('marks the root panel as a composer viewport inset target', () => {
    const { container } = render(<AskUserQuestionComposer request={makeRequest()} onRespond={vi.fn()} />)

    expect(container.firstElementChild).toHaveAttribute('data-composer-viewport-inset-target', '')
  })

  it('auto advances after option selection and submits a custom input as an answer option', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<AskUserQuestionComposer request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: /Winston/ }))

    expect(screen.getByText('Add context')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('Enter your answer...'), {
      target: { value: 'Use JSON logs' }
    })
    fireEvent.click(screen.getByText('Submit'))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    expect(onRespond).toHaveBeenCalledWith({
      match: makeRequest().match,
      approved: true,
      updatedInput: {
        questions,
        answers: {
          'Choose logger': 'Winston',
          'Add context': 'Use JSON logs'
        }
      }
    })
  })

  it('preserves selected options when navigating back after auto advance', () => {
    const onRespond = vi.fn()
    render(<AskUserQuestionComposer request={makeRequest()} onRespond={onRespond} />)

    const winston = screen.getByRole('button', { name: /Winston/ })
    fireEvent.click(winston)

    expect(screen.getByText('Add context')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }))
    expect(screen.getByRole('button', { name: /Winston/ })).toHaveAttribute('aria-pressed', 'true')
    expect(onRespond).not.toHaveBeenCalled()
  })

  it('submits the final selected option when earlier questions were skipped', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    render(<AskUserQuestionComposer request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByText('Skip'))
    expect(screen.getByText('Add context')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Bunyan/ }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    expect(onRespond).toHaveBeenCalledWith({
      match: makeRequest().match,
      approved: true,
      updatedInput: {
        questions,
        answers: {
          'Add context': 'Bunyan'
        }
      }
    })
  })

  it('wraps the full question text instead of clamping it to one line', () => {
    const question =
      '你点名了 /model.text-to-image (model=gpt-image-2@rc, provider_id=coco-rightcode) ，但消息里"提示词："后面是空的。请补充提示词，或选择继续/取消。'
    render(
      <AskUserQuestionComposer
        request={makeRequest([
          {
            question,
            header: '请选择',
            options: [{ label: '继续' }, { label: '取消' }],
            multiSelect: false
          }
        ])}
        onRespond={vi.fn()}
      />
    )

    const heading = screen.getByRole('heading', { name: question })
    expect(heading).toHaveTextContent(question)
    expect(heading.className).not.toMatch(/line-clamp-1/)
    expect(heading.className).toMatch(/whitespace-pre-wrap/)
  })

  it('adds a free-text option that focuses the input without auto-submitting', async () => {
    const onRespond = vi.fn().mockResolvedValue(undefined)
    const requestQuestions = [
      {
        question: '提示词为空，怎么处理？',
        header: '请选择',
        options: [{ label: '继续' }, { label: '取消' }],
        multiSelect: false
      }
    ]
    render(<AskUserQuestionComposer request={makeRequest(requestQuestions)} onRespond={onRespond} />)

    const other = screen.getByRole('button', { name: /Other/ })
    fireEvent.click(other)

    expect(other).toHaveAttribute('aria-pressed', 'true')
    expect(onRespond).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByPlaceholderText('Enter your answer...')).toHaveFocus())

    fireEvent.change(screen.getByPlaceholderText('Enter your answer...'), {
      target: { value: '提示词：一只红色的狐狸' }
    })
    fireEvent.click(screen.getByText('Submit'))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    expect(onRespond).toHaveBeenCalledWith({
      match: makeRequest(requestQuestions).match,
      approved: true,
      updatedInput: {
        questions: requestQuestions,
        answers: {
          '提示词为空，怎么处理？': '提示词：一只红色的狐狸'
        }
      }
    })
  })

  it('disables controls while the final response is submitting', async () => {
    const onRespond = vi.fn(() => new Promise<void>(() => undefined))
    render(<AskUserQuestionComposer request={makeRequest()} onRespond={onRespond} />)

    fireEvent.click(screen.getByRole('button', { name: /Winston/ }))
    fireEvent.click(screen.getByRole('button', { name: /Bunyan/ }))

    await waitFor(() => expect(onRespond).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByRole('button', { name: /Bunyan/ })).toBeDisabled())
  })
})
