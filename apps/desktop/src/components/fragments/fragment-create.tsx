import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { FilePart, SendMessageOptions } from "@shared/chat"
import type { FragmentKind } from "@shared/fragments"
import { Persona } from "@/src/components/ai/persona"
import { Shimmer } from "@/src/components/ai/shimmer"
import { ChatInput } from "@/src/components/chat-input"
import { useWorkspace } from "@/lib/workspace-context"
import { setInputDraft } from "@/src/stores/chat-draft"
import { embeddedChatFields } from "@/src/lib/artifact-session"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import { describeFragmentAction } from "./fragment-actions"
import { FragmentIcon } from "./fragment-icon"
import { KIND_META } from "./kind-meta"

const KINDS: FragmentKind[] = ["screen", "panel", "widget"]

/** Starting points: a sentence that fills the prompt. The person edits it, then sends. */
const STARTERS = [
  { id: "spending", icon: "wallet" },
  { id: "tasks", icon: "list-checks" },
  { id: "ai", icon: "wand-sparkles" },
] as const

/** How long each "phase" of the creating screen stays before the next one (ms). */
const PHASE_MS = 3200
const PHASES = ["phase1", "phase2", "phase3", "phase4", "phase5"] as const

/**
 * Creating a fragment: not a modal, not a card in a chat — a canvas. The heading, the
 * prompt in the middle and a few starting points; the person picks where it will live
 * (screen / side panel / widget) and describes it.
 *
 * Sending creates the fragment's OWN chat (lean, hidden from the chat list — see
 * `SessionInfo.fragment`) and the page switches to the "creating" screen, which turns
 * into the live fragment the moment the agent's first version exists.
 */
export function FragmentCreate() {
  const creating = useFragmentsStore((s) => s.creating)
  return creating ? <Creating sessionId={creating.sessionId} /> : <Compose />
}

function Compose() {
  const { t } = useTranslation()
  const leave = useFragmentsStore((s) => s.leave)
  const startCreating = useFragmentsStore((s) => s.startCreating)
  const [kind, setKind] = useState<FragmentKind>("screen")
  const [error, setError] = useState<string | null>(null)
  // A starting point fills the prompt. ChatInput restores its draft on mount, so the text is
  // written to the draft and the input is remounted (the counter is its key).
  const [seeds, setSeeds] = useState(0)

  const handleSubmit = async (text: string, options: SendMessageOptions, files?: FilePart[]) => {
    setError(null)
    try {
      const store = useSessionStore.getState()
      // The fragment's own chat: lean and out of the chat list. Nothing in the prompt about
      // how to build fragments is typed here — the lean profile carries it.
      const session = await store.createSession("chat", { setActive: false, ...embeddedChatFields("fragment", undefined, kind) })
      startCreating({ sessionId: session.id, kind })
      await store.sendMessage("chat", text, { options, sessionId: session.id, files })
    } catch (err) {
      useFragmentsStore.setState({ creating: null, composing: true })
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center pb-3">
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs text-muted-foreground" onClick={leave}>
          <ArrowLeft className="size-3.5" />
          {t("fragments.title")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-y-auto rounded-xl border border-dashed border-border/70 bg-card/40 p-6">
        <div className="text-center">
          <p className="text-lg font-medium">{t("fragments.composeTitle", { what: t(`fragments.kind.${kind}.indef`) })}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("fragments.composeHint")}</p>
        </div>

        <div className="w-full max-w-2xl">
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          <ChatInput
            key={seeds}
            onSubmit={(text, options, files) => void handleSubmit(text, options, files)}
            draftKey="fragment-new"
          />
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5" role="radiogroup" aria-label={t("fragments.kindLabel")}>
            {KINDS.map((value) => {
              const Icon = KIND_META[value].icon
              const active = kind === value
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setKind(value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors",
                    active ? "border-primary bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:bg-accent/50",
                  )}
                >
                  <Icon className="size-3.5" />
                  {t(KIND_META[value].name)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="w-full max-w-2xl">
          <p className="mb-2 text-center text-[11px] text-muted-foreground">{t("fragments.startFrom")}</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {STARTERS.map((starter) => (
              <button
                key={starter.id}
                type="button"
                onClick={() => {
                  setInputDraft("fragment-new", t(`fragments.starters.${starter.id}.prompt`))
                  setSeeds((n) => n + 1)
                }}
                className="flex items-start gap-2.5 rounded-xl border border-border/60 bg-card p-3 text-left transition-colors hover:bg-accent/50"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FragmentIcon name={starter.icon} className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{t(`fragments.starters.${starter.id}.title`)}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">{t(`fragments.starters.${starter.id}.hint`)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The wait. The persona thinks in the middle, and below it a shimmering line cycles through
 * the phases of a creation — it is a feeling of progress, not a progress report. A second,
 * quieter line shows what the agent is really doing right now.
 */
function Creating({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation()
  const { setView } = useWorkspace()
  const leave = useFragmentsStore((s) => s.leave)
  const [phase, setPhase] = useState(0)
  const messages = useSessionStore((s) => s.messages[sessionId])
  const sessionTitle = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.title)

  useEffect(() => {
    const timer = setInterval(() => setPhase((p) => (p + 1) % PHASES.length), PHASE_MS)
    return () => clearInterval(timer)
  }, [])

  // What the agent is doing right now, from the last tool call of its chat.
  const doing = useRef("")
  const lastTool = [...(messages ?? [])]
    .reverse()
    .flatMap((m) => [...m.parts].reverse())
    .find((p) => p.type === "tool")
  if (lastTool && lastTool.type === "tool") doing.current = describeFragmentAction(t, lastTool)

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-5 rounded-xl border border-dashed border-border/70 bg-card/40 p-6 text-center">
      <div className="size-32">
        <Persona state="thinking" className="!size-full" />
      </div>
      <div className="flex h-12 flex-col items-center gap-1">
        {/* keyed by phase so each one fades in instead of swapping abruptly */}
        <div key={phase} className="animate-in fade-in-0 duration-500">
          <Shimmer className="text-base font-medium">{t(`fragments.${PHASES[phase]}`)}</Shimmer>
        </div>
        <p className="h-4 text-[11px] text-muted-foreground">{doing.current}</p>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => usePanelStore.getState().openChatTab(sessionId, sessionTitle ?? t("fragments.title"))}
        >
          {t("fragments.chat.show")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            leave()
            setView("fragments")
          }}
        >
          {t("fragments.backToList")}
        </Button>
      </div>
    </div>
  )
}
