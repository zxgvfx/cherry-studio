import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import AiPipelinePage from '../AiPipelinePage'

describe('AiPipelinePage', () => {
  it('allows workflow confirmation dialogs inside the sandboxed iframe', () => {
    render(<AiPipelinePage />)

    expect(screen.getByTitle('AI Pipeline')).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals'
    )
  })
})
