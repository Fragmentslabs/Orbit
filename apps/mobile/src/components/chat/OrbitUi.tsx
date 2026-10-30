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
 * Inline blocks of the assistant answer (```orbit-ui fence) in the mobile app —
 * the mirror of the desktop `generative-ui.tsx`, with the SAME contract from shared
 * (`parseOrbitUi` + `orbit-expr`) and the design system of the conversation.
 *
 * What used to fall through as a code block with raw JSON now becomes a component.
 * Interactivity is declarative: the inputs (slider, select…) write to a local
 * state of the fence, every text with `{expr}` resolves against it — including
 * charts and progress bars — and only the buttons with `action: "send"` talk
 * to the chat.
 */

/** One block by its type; each component receives its own props. */
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
      // Markdown already separates `nav` before getting here (the card has its own
      // navigation path); this case exists for whoever renders a whole fence
      // at once.
      return <NavCard destination={block.destination} note={block.note} />
  }
}

type Layout = { start: number; blocks: OrbitUiBlock[]; grouped: boolean }

/**
 * Consecutive inputs (except tabs) share a panel: four sliders in
 * a row become a single control, not four loose tracks — the sliders are the
 * source of the formulas, and together they read as a form.
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

/** Blocks already parsed (Markdown hands over the ready list of the fence). */
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

/** Raw fence: parse + render, for whoever has the text at hand (and for the tests). */
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
