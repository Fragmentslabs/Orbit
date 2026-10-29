import { memo, useMemo, useState } from 'react'
import { View } from 'react-native'
import {
  evalCondition,
  parseOrbitUi,
  type OrbitUiBlock,
  type Scope,
  type Value,
} from '@orbit/shared'
import { NavCard } from '~/components/chat/NavCard'
import { useLocaleStore } from '~/stores/locale-store'
import { UiContext, defaultsOf, isInputBlock, sendToActiveSession, type UiState } from './OrbitUi/context'
import { Callout, Checklist, Compare, DataTable, KeyValue, Progress, Stats, Steps } from './OrbitUi/display'
import { Chart } from './OrbitUi/chart'
import {
  Buttons,
  NumberInput,
  SelectInput,
  SliderInput,
  Tabs,
  TextInputBlock,
  ToggleInput,
} from './OrbitUi/inputs'
import { panelBg, useTokens } from './OrbitUi/style'

/**
 * Blocos inline da resposta do assistente (fence ```orbit-ui) no app mobile —
 * o espelho do `generative-ui.tsx` do desktop, com o MESMO contrato do shared
 * (`parseOrbitUi` + `orbit-expr`) e o design system da conversa.
 *
 * O que antes caía como bloco de código com JSON cru agora vira componente.
 * Interatividade é declarativa: as entradas (slider, select…) gravam num estado
 * local do fence, todo texto com `{expr}` resolve contra ele — inclusive
 * gráficos e barras de progresso — e só os botões com `action: "send"` falam
 * com o chat.
 */

/** Um bloco pelo seu tipo; cada componente recebe as próprias props. */
function Block({ block }: { block: OrbitUiBlock }) {
  switch (block.type) {
    case 'stats':
      return <Stats {...block} />
    case 'callout':
      return <Callout {...block} />
    case 'steps':
      return <Steps {...block} />
    case 'table':
      return <DataTable {...block} />
    case 'chart':
      return <Chart {...block} />
    case 'checklist':
      return <Checklist {...block} />
    case 'compare':
      return <Compare {...block} />
    case 'kv':
      return <KeyValue {...block} />
    case 'progress':
      return <Progress {...block} />
    case 'slider':
      return <SliderInput {...block} />
    case 'number':
      return <NumberInput {...block} />
    case 'select':
      return <SelectInput {...block} />
    case 'tabs':
      return <Tabs {...block} />
    case 'toggle':
      return <ToggleInput {...block} />
    case 'text':
      return <TextInputBlock {...block} />
    case 'buttons':
      return <Buttons {...block} />
    case 'nav':
      // O Markdown já separa `nav` antes de chegar aqui (o cartão tem o próprio
      // caminho de navegação); este caso existe para quem renderiza um fence
      // inteiro de uma vez.
      return <NavCard destino={block.destino} nota={block.nota} />
  }
}

type Layout = { start: number; blocks: OrbitUiBlock[]; grouped: boolean }

/**
 * Entradas consecutivas (exceto abas) dividem um painel: quatro sliders em
 * sequência viram um controle só, não quatro faixas soltas — os sliders são a
 * fonte das fórmulas, e juntos se leem como um formulário.
 */
function layoutOf(blocks: OrbitUiBlock[]): Layout[] {
  const out: Layout[] = []
  blocks.forEach((block, index) => {
    const groupable = isInputBlock(block) && block.type !== 'tabs'
    const last = out[out.length - 1]
    if (groupable && last?.grouped) last.blocks.push(block)
    else out.push({ start: index, blocks: [block], grouped: groupable })
  })
  return out
}

/** Blocos já parseados (o Markdown entrega a lista pronta do fence). */
export const OrbitUiBlocks = memo(function OrbitUiBlocks({
  blocks,
  pending = false,
}: {
  blocks: OrbitUiBlock[]
  pending?: boolean
}) {
  const locale = useLocaleStore((s) => s.locale)
  const tokens = useTokens()
  const defaults = useMemo(() => defaultsOf(blocks), [blocks])
  const [overrides, setOverrides] = useState<Scope>({})
  const scope = useMemo(() => ({ ...defaults, ...overrides }), [defaults, overrides])
  const layout = useMemo(() => layoutOf(blocks), [blocks])

  const state = useMemo<UiState>(
    () => ({
      scope,
      locale,
      setValue: (id: string, value: Value) => setOverrides((prev) => ({ ...prev, [id]: value })),
      send: sendToActiveSession,
    }),
    [scope, locale],
  )

  if (blocks.length === 0 && !pending) return null

  return (
    <UiContext.Provider value={state}>
      <View style={{ gap: 10 }}>
        {layout.map((group) => {
          const visible = group.blocks.filter((block) =>
            evalCondition((block as { showIf?: string }).showIf, scope),
          )
          if (visible.length === 0) return null
          if (!group.grouped) {
            return (
              <View key={group.start}>
                <Block block={visible[0]} />
              </View>
            )
          }
          return (
            <View
              key={group.start}
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'flex-end',
                columnGap: 16,
                rowGap: 12,
                borderRadius: 12,
                backgroundColor: panelBg(tokens),
                paddingHorizontal: 12,
                paddingVertical: 10,
              }}
            >
              {visible.map((block, i) => (
                <Block key={i} block={block} />
              ))}
            </View>
          )
        })}
        {pending ? (
          <View style={{ height: 64, borderRadius: 12, backgroundColor: panelBg(tokens) }} />
        ) : null}
      </View>
    </UiContext.Provider>
  )
})

/** Fence cru: parse + render, para quem tem o texto em mãos (e para os testes). */
export const OrbitUiFence = memo(function OrbitUiFence({
  code,
  incomplete = false,
}: {
  code: string
  incomplete?: boolean
}) {
  const { blocks, pending } = useMemo(() => parseOrbitUi(code, incomplete), [code, incomplete])
  return <OrbitUiBlocks blocks={blocks} pending={pending} />
})
