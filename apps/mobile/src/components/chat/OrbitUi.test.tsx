import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

/**
 * Blocos `orbit-ui` no app mobile.
 *
 * O que se testa é o comportamento que o celular ganhou: cada tipo desenha (e
 * não cai mais como JSON cru), as fórmulas dos textos resolvem contra as
 * entradas, mexer numa entrada atualiza quem depende dela e o botão `send`
 * fala com a sessão do chat. O JSON inválido continua virando bloco de código —
 * nunca uma mensagem quebrada.
 *
 * O runner é o vitest com `react-native` resolvido para `react-native-web`
 * (ver vitest.config.ts): são os mesmos componentes, renderizados no jsdom.
 */

// ── Plataforma ────────────────────────────────────────────────────────────
// Nada de módulo nativo no Node: só o que o componente usa é substituído.

vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}))

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }))

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

// Rótulos de tela não interessam aqui: a asserção do cartão `nav` usa a chave.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// Locale fixo: os números formatados no teste não podem depender do sistema.
vi.mock('~/stores/locale-store', () => ({
  useLocaleStore: (selector: (state: { locale: string }) => unknown) => selector({ locale: 'pt-BR' }),
}))

const { sendMessage, session } = vi.hoisted(() => {
  const sendMessage = vi.fn(async (_text: string, _config?: unknown) => {})
  return { sendMessage, session: { activeSessionId: 'sess-1' as string | null, sendMessage } }
})

vi.mock('~/stores/session-store', () => ({
  useSessionStore: Object.assign(() => session, { getState: () => session }),
}))

import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { OrbitUiBlocks, OrbitUiFence } from '~/components/chat/OrbitUi'
import { parseOrbitUi } from '@orbit/shared'

afterEach(() => {
  cleanup()
  sendMessage.mockClear()
  session.activeSessionId = 'sess-1'
})

/** Um bloco válido de cada tipo do schema — e o texto que ele deve mostrar. */
const CASES: { name: string; json: string; expect: string }[] = [
  { name: 'stats', json: '{"type":"stats","items":[{"label":"MRR","value":"{capital*2|0}"}]}', expect: 'MRR' },
  { name: 'callout', json: '{"type":"callout","text":"Atenção"}', expect: 'Atenção' },
  { name: 'steps', json: '{"type":"steps","items":[{"title":"Abrir"},{"title":"Salvar"}]}', expect: 'Abrir' },
  { name: 'table', json: '{"type":"table","columns":["A","B"],"rows":[["1","2"]]}', expect: 'A' },
  {
    name: 'chart bar',
    json: '{"type":"chart","kind":"bar","title":"Vendas","data":[{"label":"jan","value":10},{"label":"fev","value":20}]}',
    expect: 'jan',
  },
  {
    name: 'chart line',
    json: '{"type":"chart","kind":"line","title":"Curva","fns":[{"fn":"x*2"}],"x":[0,10]}',
    expect: 'Curva',
  },
  {
    name: 'chart area',
    json: '{"type":"chart","kind":"area","title":"Área","data":[{"label":"a","value":1},{"label":"b","value":2}]}',
    expect: 'Área',
  },
  {
    name: 'chart pie',
    json: '{"type":"chart","kind":"pie","title":"Fatias","data":[{"label":"a","value":3},{"label":"b","value":1}]}',
    expect: 'Fatias',
  },
  { name: 'checklist', json: '{"type":"checklist","items":[{"text":"feito","done":true}]}', expect: 'feito' },
  {
    name: 'compare',
    json: '{"type":"compare","items":[{"title":"A","points":["x"]},{"title":"B","points":["y"]}]}',
    expect: 'B',
  },
  { name: 'kv', json: '{"type":"kv","items":[{"label":"Taxa","value":12}]}', expect: 'Taxa' },
  { name: 'progress', json: '{"type":"progress","items":[{"label":"Meta","value":"{capital/10}"}]}', expect: 'Meta' },
  {
    name: 'slider',
    json: '{"type":"slider","id":"capital","label":"Capital","min":0,"max":10000,"value":1000}',
    expect: 'Capital',
  },
  { name: 'number', json: '{"type":"number","id":"anos","label":"Anos","value":2}', expect: 'Anos' },
  {
    name: 'select',
    json: '{"type":"select","id":"plano","label":"Plano","options":["Básico","Pro"]}',
    expect: 'Plano',
  },
  { name: 'tabs', json: '{"type":"tabs","id":"cenario","options":["Cenário A","Cenário B"]}', expect: 'Cenário B' },
  { name: 'toggle', json: '{"type":"toggle","id":"juros","label":"Com juros","value":true}', expect: 'Com juros' },
  { name: 'text', json: '{"type":"text","id":"nome","label":"Nome"}', expect: 'Nome' },
  {
    name: 'buttons',
    json: '{"type":"buttons","items":[{"label":"Sim","action":"send","text":"Sim"},{"label":"Copiar","action":"copy","text":"x"}]}',
    expect: 'Copiar',
  },
  { name: 'nav', json: '{"type":"nav","destino":"providers"}', expect: 'orbitUi.nav.open' },
]

describe('OrbitUiBlocks', () => {
  it.each(CASES)('desenha o bloco %s', ({ json, expect: expected }) => {
    const { blocks } = parseOrbitUi(json, false)
    expect(blocks).toHaveLength(1)

    render(<OrbitUiBlocks blocks={blocks} />)

    // Desenhou de verdade (texto do bloco na tela) e nada de JSON cru.
    expect(screen.getByText(expected)).toBeTruthy()
    expect(screen.queryByText(json)).toBeNull()
  })

  it('resolve a fórmula contra o valor da entrada e acompanha a mudança', () => {
    const code = [
      '{"type":"number","id":"capital","label":"Capital","value":1000}',
      '{"type":"stats","items":[{"label":"Dobro","value":"{capital*2|0}"}]}',
    ].join('\n')
    render(<OrbitUiFence code={code} />)

    expect(screen.getByText('2.000')).toBeTruthy()

    // Mexer na entrada recalcula o texto: é o que faz o bloco ser interativo.
    fireEvent.change(screen.getByLabelText('Capital'), { target: { value: '1500' } })
    expect(screen.getByText('3.000')).toBeTruthy()
  })

  it('avalia a fórmula de um bloco de texto digitado', () => {
    const code = [
      '{"type":"number","id":"anos","label":"Anos","value":2}',
      '{"type":"progress","items":[{"label":"Andamento","value":"anos*25"}]}',
    ].join('\n')
    render(<OrbitUiFence code={code} />)

    expect(screen.getByText('50%')).toBeTruthy()
  })

  it('mostra o esqueleto da linha que ainda está chegando', () => {
    const { container, rerender } = render(<OrbitUiFence code={'{"type":"callout","text":"Atenção"}'} incomplete />)
    expect(container).toBeTruthy()
    // Fence com a última linha pela metade: o bloco válido aparece, o resto espera.
    rerender(<OrbitUiFence code={'{"type":"callout","text":"Atenção"}\n{"type":"stats","ite'} incomplete />)
    expect(screen.getByText('Atenção')).toBeTruthy()
  })

  it('esconde o bloco com showIf falso', () => {
    const code = [
      '{"type":"toggle","id":"caro","label":"Incluir taxas","value":false}',
      '{"type":"callout","showIf":"caro","text":"Com taxas"}',
    ].join('\n')
    render(<OrbitUiFence code={code} />)

    expect(screen.queryByText('Com taxas')).toBeNull()
    fireEvent.click(screen.getByText('Incluir taxas'))
    expect(screen.getByText('Com taxas')).toBeTruthy()
  })

  it('o botão send manda a mensagem para a sessão aberta', () => {
    const code =
      '{"type":"buttons","items":[{"label":"Quero sim","action":"send","text":"Quero sim, pode fazer"}]}'
    render(<OrbitUiFence code={code} />)

    fireEvent.click(screen.getByText('Quero sim'))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('Quero sim, pode fazer', { sessionId: 'sess-1' })
  })

  it('sem sessão aberta, o botão não finge que enviou', () => {
    session.activeSessionId = null
    render(<OrbitUiFence code={'{"type":"buttons","items":[{"label":"OK","action":"send","text":"ok"}]}'} />)

    fireEvent.click(screen.getByText('OK'))

    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('AssistantMarkdown com fence orbit-ui', () => {
  it('desenha o bloco em vez do JSON', () => {
    const text = ['Olha o resultado:', '```orbit-ui', '{"type":"stats","items":[{"label":"MRR","value":"12k"}]}', '```'].join(
      '\n',
    )
    render(<AssistantMarkdown text={text} />)

    expect(screen.getByText('MRR')).toBeTruthy()
    expect(screen.queryByText(/"type"/)).toBeNull()
  })

  it('JSON inválido cai no bloco de código em vez de quebrar a mensagem', () => {
    const text = ['```orbit-ui', '{"type":"stats","items":', '```'].join('\n')

    const { container } = render(<AssistantMarkdown text={text} />)

    // O texto continua visível, agora como código — nada sumiu da tela (e o
    // realce de sintaxe quebra o JSON em vários spans, daí o textContent).
    expect(container.textContent).toContain('"type":"stats"')
  })

  it('mantém o cartão de navegação do tipo nav', () => {
    const text = ['```orbit-ui', '{"type":"nav","destino":"providers","nota":"Aqui ficam as chaves"}', '```'].join('\n')
    render(<AssistantMarkdown text={text} />)

    expect(screen.getByText('orbitUi.nav.open')).toBeTruthy()
    expect(screen.getByText('Aqui ficam as chaves')).toBeTruthy()
  })

  it('um fence misto desenha o nav e os outros blocos juntos', () => {
    const text = [
      '```orbit-ui',
      '{"type":"callout","text":"Antes de tudo"}',
      '{"type":"nav","destino":"providers"}',
      '{"type":"kv","items":[{"label":"Modelo","value":"gpt"}]}',
      '```',
    ].join('\n')
    render(<AssistantMarkdown text={text} />)

    expect(screen.getByText('Antes de tudo')).toBeTruthy()
    expect(screen.getByText('orbitUi.nav.open')).toBeTruthy()
    expect(screen.getByText('gpt')).toBeTruthy()
  })
})
