/**
 * ```mermaid in the chat markdown: it draws, and degrades to the code when there is
 * nothing to draw. The drawing itself (the lib inside the WebView) does not run in jsdom —
 * what is guaranteed here is the decision of which of the two shows up, which is where the
 * user loses or does not lose the diagram.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'

// The real bundle is 3.4 MB read through expo-asset, which does not exist in jsdom. The
// read is the only point replaced: the rest of the component really runs.
vi.mock('~/lib/mermaid-source', () => ({
  loadMermaidSource: () => Promise.resolve('window.mermaid = {};'),
}))

const FENCE = '```mermaid\ngraph TD\n  A-->B\n```'

afterEach(cleanup)

describe('mermaid in markdown', () => {
  it('a closed fence becomes a diagram host', async () => {
    render(<AssistantMarkdown text={FENCE} />)
    expect(await screen.findByTestId('piece-view')).toBeTruthy()
  })

  it('an open fence in the stream is still the source code', () => {
    const { container } = render(
      <AssistantMarkdown text={'```mermaid\ngraph TD\n  A-->B'} streaming />,
    )
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(container.textContent).toContain('graph TD')
  })

  it('an empty fence does not become a diagram', () => {
    render(<AssistantMarkdown text={'```mermaid\n\n```'} />)
    expect(screen.queryByTestId('piece-view')).toBeNull()
  })

  it('another language is not affected', () => {
    const { container } = render(<AssistantMarkdown text={'```ts\nconst a = 1\n```'} />)
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(container.textContent).toContain('const a = 1')
  })

  it('tolerates a suffix after the language', async () => {
    render(<AssistantMarkdown text={'```mermaid title="Fluxo"\ngraph TD\n  A-->B\n```'} />)
    expect(await screen.findByTestId('piece-view')).toBeTruthy()
  })
})
