import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
// The `vi.mock` below are hoisted by vitest above these imports — the order
// here is only for reading (the `import/first` rule complains about an import after a mock).
import { AssistantMarkdown } from '~/components/chat/AssistantMarkdown'
import { OrbitUiBlocks, OrbitUiFence } from '~/components/chat/OrbitUi'
import { parseOrbitUi } from '@orbit/shared'

/**
 * `orbit-ui` blocks in the mobile app.
 *
 * What is tested is the behavior the phone gained: each type draws (and
 * no longer falls through as raw JSON), the formulas of the texts resolve against the
 * inputs, touching an input updates whoever depends on it and the `send` button
 * talks to the chat session. Invalid JSON keeps becoming a code block —
 * never a broken message.
 *
 * The runner is vitest with `react-native` resolved to `react-native-web`
 * (see vitest.config.ts): they are the same components, rendered in jsdom.
 */

// ── Platform ────────────────────────────────────────────────────────────
// No native module in Node: only what the component uses is replaced.

vi.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}))

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }))

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}))

// Screen labels are of no interest here: the assertion of the `nav` card uses the key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'pt-BR' } }),
}))

// Fixed locale: the numbers formatted in the test cannot depend on the system.
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

afterEach(() => {
  cleanup()
  sendMessage.mockClear()
  session.activeSessionId = 'sess-1'
})

/** One valid block of each type of the schema — and the text it should show. */
const CASES: { name: string; json: string; expect: string }[] = [
  { name: 'stats', json: '{"type":"stats","items":[{"label":"MRR","value":"{capital*2|0}"}]}', expect: 'MRR' },
  { name: 'callout', json: '{"type":"callout","text":"Attention"}', expect: 'Attention' },
  { name: 'steps', json: '{"type":"steps","items":[{"title":"Open"},{"title":"Save"}]}', expect: 'Open' },
  { name: 'table', json: '{"type":"table","columns":["A","B"],"rows":[["1","2"]]}', expect: 'A' },
  {
    name: 'chart bar',
    json: '{"type":"chart","kind":"bar","title":"Sales","data":[{"label":"jan","value":10},{"label":"feb","value":20}]}',
    expect: 'jan',
  },
  {
    name: 'chart line',
    json: '{"type":"chart","kind":"line","title":"Curve","fns":[{"fn":"x*2"}],"x":[0,10]}',
    expect: 'Curve',
  },
  {
    name: 'chart area',
    json: '{"type":"chart","kind":"area","title":"Area","data":[{"label":"a","value":1},{"label":"b","value":2}]}',
    expect: 'Area',
  },
  {
    name: 'chart pie',
    json: '{"type":"chart","kind":"pie","title":"Slices","data":[{"label":"a","value":3},{"label":"b","value":1}]}',
    expect: 'Slices',
  },
  { name: 'checklist', json: '{"type":"checklist","items":[{"text":"done","done":true}]}', expect: 'done' },
  {
    name: 'compare',
    json: '{"type":"compare","items":[{"title":"A","points":["x"]},{"title":"B","points":["y"]}]}',
    expect: 'B',
  },
  { name: 'kv', json: '{"type":"kv","items":[{"label":"Rate","value":12}]}', expect: 'Rate' },
  { name: 'progress', json: '{"type":"progress","items":[{"label":"Goal","value":"{capital/10}"}]}', expect: 'Goal' },
  {
    name: 'slider',
    json: '{"type":"slider","id":"capital","label":"Capital","min":0,"max":10000,"value":1000}',
    expect: 'Capital',
  },
  { name: 'number', json: '{"type":"number","id":"years","label":"Years","value":2}', expect: 'Years' },
  {
    name: 'select',
    json: '{"type":"select","id":"plan","label":"Plan","options":["Basic","Pro"]}',
    expect: 'Plan',
  },
  { name: 'tabs', json: '{"type":"tabs","id":"scenario","options":["Scenario A","Scenario B"]}', expect: 'Scenario B' },
  { name: 'toggle', json: '{"type":"toggle","id":"interest","label":"With interest","value":true}', expect: 'With interest' },
  { name: 'text', json: '{"type":"text","id":"name","label":"Name"}', expect: 'Name' },
  {
    name: 'buttons',
    json: '{"type":"buttons","items":[{"label":"Yes","action":"send","text":"Yes"},{"label":"Copy","action":"copy","text":"x"}]}',
    expect: 'Copy',
  },
  { name: 'nav', json: '{"type":"nav","destination":"providers"}', expect: 'orbitUi.nav.open' },
]

describe('OrbitUiBlocks', () => {
  it.each(CASES)('draws the %s block', ({ json, expect: expected }) => {
    const { blocks } = parseOrbitUi(json, false)
    expect(blocks).toHaveLength(1)

    render(<OrbitUiBlocks blocks={blocks} />)

    // Actually drew (block text on screen) and no raw JSON.
    expect(screen.getByText(expected)).toBeTruthy()
    expect(screen.queryByText(json)).toBeNull()
  })

  it('resolves the formula against the input value and follows the change', () => {
    const code = [
      '{"type":"number","id":"capital","label":"Capital","value":1000}',
      '{"type":"stats","items":[{"label":"Double","value":"{capital*2|0}"}]}',
    ].join('\n')
    render(<OrbitUiFence code={code} />)

    expect(screen.getByText('2.000')).toBeTruthy()

    // Touching the input recomputes the text: that is what makes the block interactive.
    fireEvent.change(screen.getByLabelText('Capital'), { target: { value: '1500' } })
    expect(screen.getByText('3.000')).toBeTruthy()
  })

  it('evaluates the formula of a typed text block', () => {
    const code = [
      '{"type":"number","id":"years","label":"Years","value":2}',
      '{"type":"progress","items":[{"label":"Progress","value":"years*25"}]}',
    ].join('\n')
    render(<OrbitUiFence code={code} />)

    expect(screen.getByText('50%')).toBeTruthy()
  })

  it('shows the skeleton of the line that is still arriving', () => {
    const { container, rerender } = render(<OrbitUiFence code={'{"type":"callout","text":"Attention"}'} incomplete />)
    expect(container).toBeTruthy()
    // Fence with the last line half done: the valid block shows up, the rest waits.
    rerender(<OrbitUiFence code={'{"type":"callout","text":"Attention"}\n{"type":"stats","ite'} incomplete />)
    expect(screen.getByText('Attention')).toBeTruthy()
  })

  it('hides the block with a false showIf', () => {
    const code = [
      '{"type":"toggle","id":"expensive","label":"Include fees","value":false}',
      '{"type":"callout","showIf":"expensive","text":"With fees"}',
    ].join('\n')
    render(<OrbitUiFence code={code} />)

    expect(screen.queryByText('With fees')).toBeNull()
    fireEvent.click(screen.getByText('Include fees'))
    expect(screen.getByText('With fees')).toBeTruthy()
  })

  it('the send button delivers the message to the open session', () => {
    const code =
      '{"type":"buttons","items":[{"label":"Yes please","action":"send","text":"Yes please, go ahead"}]}'
    render(<OrbitUiFence code={code} />)

    fireEvent.click(screen.getByText('Yes please'))

    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith('Yes please, go ahead', { sessionId: 'sess-1' })
  })

  it('with no open session, the button does not pretend it sent', () => {
    session.activeSessionId = null
    render(<OrbitUiFence code={'{"type":"buttons","items":[{"label":"OK","action":"send","text":"ok"}]}'} />)

    fireEvent.click(screen.getByText('OK'))

    expect(sendMessage).not.toHaveBeenCalled()
  })
})

describe('AssistantMarkdown with an orbit-ui fence', () => {
  it('draws the block instead of the JSON', () => {
    const text = ['Look at the result:', '```orbit-ui', '{"type":"stats","items":[{"label":"MRR","value":"12k"}]}', '```'].join(
      '\n',
    )
    render(<AssistantMarkdown text={text} />)

    expect(screen.getByText('MRR')).toBeTruthy()
    expect(screen.queryByText(/"type"/)).toBeNull()
  })

  it('invalid JSON falls back to the code block instead of breaking the message', () => {
    const text = ['```orbit-ui', '{"type":"stats","items":', '```'].join('\n')

    const { container } = render(<AssistantMarkdown text={text} />)

    // The text stays visible, now as code — nothing vanished from the screen (and the
    // syntax highlighting breaks the JSON into several spans, hence the textContent).
    expect(container.textContent).toContain('"type":"stats"')
  })

  it('keeps the navigation card of type nav', () => {
    const text = ['```orbit-ui', '{"type":"nav","destination":"providers","note":"The keys live here"}', '```'].join('\n')
    render(<AssistantMarkdown text={text} />)

    expect(screen.getByText('orbitUi.nav.open')).toBeTruthy()
    expect(screen.getByText('The keys live here')).toBeTruthy()
  })

  it('a mixed fence draws the nav and the other blocks together', () => {
    const text = [
      '```orbit-ui',
      '{"type":"callout","text":"Before everything"}',
      '{"type":"nav","destino":"providers"}',
      '{"type":"kv","items":[{"label":"Model","value":"gpt"}]}',
      '```',
    ].join('\n')
    render(<AssistantMarkdown text={text} />)

    expect(screen.getByText('Before everything')).toBeTruthy()
    expect(screen.getByText('orbitUi.nav.open')).toBeTruthy()
    expect(screen.getByText('gpt')).toBeTruthy()
  })
})
