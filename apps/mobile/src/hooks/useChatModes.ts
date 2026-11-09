import { useCallback, type ComponentType } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, Globe, AlignLeft, BrainCircuit, Bot, Network, RefreshCw, Eye, FileText } from 'lucide-react-native'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { useModeActive, useModeOverrides } from '~/stores/mode-overrides'
import { useSimpleMode, useSimplePrefs } from '~/stores/simple-prefs'
import { useBrainEnabled, useBrainPrefs } from '~/stores/brain-prefs'
import { useLoopPrefs } from '~/stores/loop-prefs'
import { useModelModePrefs } from '~/stores/model-mode-prefs'
import { useSettingsStore } from '~/stores/settings-store'

/**
 * The modes of the chat, in one place.
 *
 * Before, the input owned the whole list (icons, labels, toggles and the first-time
 * gate of the workers) and the header had no way to know what was on. Now the
 * header only READS the active ones and the sheet turns them on — both from here,
 * so the two can never disagree.
 */

export type ChatModeId =
  | 'search'
  | 'browser'
  | 'plan'
  | 'simple'
  | 'brain'
  | 'subagents'
  | 'orchestra'
  | 'loop'
  | 'vision'

export interface ChatMode {
  id: ChatModeId
  icon: ComponentType<{ size?: number; color?: string }>
  label: string
  active: boolean
  onToggle: () => void
}

/**
 * What to do when a mode cannot just be flipped: vision without a configured model and
 * the workers (subagents/orchestra) without one open their own configuration. The mode
 * is turned on anyway — same rule as before.
 */
export interface ChatModeGates {
  onVisionNeedsConfig?: () => void
  onWorkerNeedsConfig?: () => void
}

interface ModeDef {
  id: ChatModeId
  icon: ChatMode['icon']
  label: string
}

export function useChatModes(sessionId: string | undefined, gates: ChatModeGates = {}) {
  const { t } = useTranslation()
  const isCode = useWorkspaceStore((s) => s.mode) === 'code'
  // Active modes per chat: override (mode-overrides/simple/brain) ?? default
  // (model-mode-prefs, separated by chat/code mode) — mirror of the desktop.
  const defaults = useModelModePrefs((s) => (isCode ? s.codeActiveModes : s.chatActiveModes))

  const search = useModeActive('search', sessionId, defaults.search)
  const browser = useModeActive('browser', sessionId, defaults.browser)
  const plan = useModeActive('plan', sessionId, defaults.plan)
  const subagents = useModeActive('subagents', sessionId, defaults.subagents)
  const orchestra = useModeActive('orchestra', sessionId, defaults.orchestra)
  const vision = useModeActive('vision', sessionId, defaults.vision)
  const simple = useSimpleMode(sessionId, defaults.simple)
  const brain = useBrainEnabled(sessionId, defaults.brain)
  const loop = useLoopPrefs((s) => s.enabled)

  const setModeActive = useModeOverrides((s) => s.setMode)
  const setSimple = useSimplePrefs((s) => s.setEnabled)
  const setBrain = useBrainPrefs((s) => s.setEnabled)
  const setLoop = useLoopPrefs((s) => s.setEnabled)

  const workerModel = useSettingsStore((s) => s.workerModel)
  const visionModel = useSettingsStore((s) => s.visionModel)

  const onVisionNeedsConfig = gates.onVisionNeedsConfig
  const onWorkerNeedsConfig = gates.onWorkerNeedsConfig

  const setActive = useCallback(
    (id: ChatModeId, next: boolean) => {
      switch (id) {
        case 'search':
        case 'browser':
        case 'plan':
          setModeActive(id, sessionId, next)
          return
        case 'simple':
          setSimple(sessionId, next)
          return
        case 'brain':
          setBrain(sessionId, next)
          return
        case 'loop':
          setLoop(next)
          return
        case 'vision':
          // Without a configured model there is nothing to look at: the configuration opens.
          if (next && !visionModel) {
            onVisionNeedsConfig?.()
            return
          }
          setModeActive('vision', sessionId, next)
          return
        case 'subagents':
        case 'orchestra':
          setModeActive(id, sessionId, next)
          if (next && !workerModel) onWorkerNeedsConfig?.()
          return
      }
    },
    [sessionId, setModeActive, setSimple, setBrain, setLoop, visionModel, workerModel, onVisionNeedsConfig, onWorkerNeedsConfig],
  )

  const states: Record<ChatModeId, boolean> = {
    search,
    browser,
    plan,
    simple,
    brain,
    subagents,
    orchestra,
    loop,
    vision,
  }

  // Same order as the desktop input (search, plan, simple, brain, subagents,
  // orchestra, loop, vision). Browser only exists in chat mode: in code mode it is not
  // even on the desktop (the browser of the right panel is another thing).
  const defs: ModeDef[] = [
    { id: 'search', icon: Search, label: t('promptInput.modes.research') },
    ...(isCode
      ? [{ id: 'plan' as const, icon: FileText, label: t('promptInput.modes.plan') }]
      : [{ id: 'browser' as const, icon: Globe, label: t('promptInput.modes.browser') }]),
    { id: 'simple', icon: AlignLeft, label: t('promptInput.modes.simple') },
    { id: 'brain', icon: BrainCircuit, label: t('promptInput.modes.brain') },
    { id: 'subagents', icon: Bot, label: t('promptInput.modes.subagents') },
    ...(isCode ? [{ id: 'orchestra' as const, icon: Network, label: t('promptInput.modes.orchestra') }] : []),
    { id: 'loop', icon: RefreshCw, label: t('promptInput.modes.loop') },
    { id: 'vision', icon: Eye, label: t('promptInput.modes.vision') },
  ]

  const modes: ChatMode[] = defs.map((def) => ({
    ...def,
    active: states[def.id],
    onToggle: () => setActive(def.id, !states[def.id]),
  }))

  return {
    /** Every mode of this chat, in the desktop order (the sheet lists them). */
    modes,
    /** Only the ones turned on, in the same order (the header shows them). */
    activeModes: modes.filter((mode) => mode.active),
    /** Read outside the list — the send options still need the raw flags. */
    states,
  }
}
