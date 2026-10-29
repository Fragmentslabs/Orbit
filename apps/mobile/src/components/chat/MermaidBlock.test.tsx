/**
 * ```mermaid no markdown do chat: desenha, e degrada para o código quando não há
 * o que desenhar. O desenho em si (a lib dentro do WebView) não roda no jsdom —
 * o que se garante aqui é a decisão de qual dos dois aparece, que é onde o
 * usuário perde ou não o diagrama.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'

// O bundle real são 3,4 MB lidos via expo-asset, que não existe no jsdom. A
// leitura é o único ponto trocado: o resto do componente roda de verdade.
vi.mock('~/lib/mermaid-source', () => ({
  loadMermaidSource: () => Promise.resolve('window.mermaid = {};'),
}))

const FENCE = '```mermaid\ngraph TD\n  A-->B\n```'

afterEach(cleanup)

describe('mermaid no markdown', () => {
  it('cerca fechada vira um host de diagrama', async () => {
    render(<AssistantMarkdown text={FENCE} />)
    expect(await screen.findByTestId('piece-view')).toBeTruthy()
  })

  it('cerca aberta no stream continua sendo o código-fonte', () => {
    const { container } = render(
      <AssistantMarkdown text={'```mermaid\ngraph TD\n  A-->B'} streaming />,
    )
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(container.textContent).toContain('graph TD')
  })

  it('fence vazio não vira diagrama', () => {
    render(<AssistantMarkdown text={'```mermaid\n\n```'} />)
    expect(screen.queryByTestId('piece-view')).toBeNull()
  })

  it('outra linguagem não é afetada', () => {
    const { container } = render(<AssistantMarkdown text={'```ts\nconst a = 1\n```'} />)
    expect(screen.queryByTestId('piece-view')).toBeNull()
    expect(container.textContent).toContain('const a = 1')
  })

  it('tolera sufixo depois da linguagem', async () => {
    render(<AssistantMarkdown text={'```mermaid title="Fluxo"\ngraph TD\n  A-->B\n```'} />)
    expect(await screen.findByTestId('piece-view')).toBeTruthy()
  })
})
