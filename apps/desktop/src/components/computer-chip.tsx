import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDownIcon, MonitorIcon, PinIcon, SquareIcon, XIcon } from "lucide-react"
import type { ComputerActivity } from "@shared/computer"
import { cn } from "@/lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Shimmer } from "@/src/components/ai/shimmer"
import { ComputerShotImage, useComputerShot, useComputerThumbPin } from "@/src/components/computer-thumb"
import { computerStopShortcut } from "@shared/computer"
import { computerApi, windowApi } from "@/src/lib/ipc"
import { useSessionStore } from "@/src/stores/session-store"
import { Hint } from "@/components/ui/hint"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Chip "Controlando <app>" no header enquanto o agente desta conversa controla
 * o computador: app atual, tempo desde o início e Parar — que aborta o turno
 * inteiro (o mesmo do ⌘⇧.). Some quando o controle termina (fim do turno,
 * ociosidade ou Parar).
 *
 * O chip abre a miniatura da tela controlada, porque com o Orbit na frente o
 * app costuma estar atrás dele e a pessoa não vê o que o agente faz:
 *  - hover espia (abre depois de um instante, fecha ao sair);
 *  - clique fixa o popover até Esc, clique fora ou outro clique — é o que
 *    funciona por teclado e trackpad;
 *  - abre sozinho só quando a tela importa para a decisão: um pedido de
 *    aprovação para agir num app, ou as ações seguidas que não mudam nada;
 *  - "Fixar acima da mensagem" troca o popover por um card ao lado do campo,
 *    para assistir uma tarefa longa sem segurar o mouse parado.
 */

const activity = new Map<string, ComputerActivity>()
const listeners = new Set<() => void>()
let subscribed = false

/** Espera do hover antes de abrir: passar o mouse pelo header a caminho de outra coisa não abre nada. */
const PEEK_OPEN_MS = 300
/** Tolerância ao sair: dá tempo de levar o mouse do chip até os botões do popover. */
const PEEK_CLOSE_MS = 200

/** Tools do Computer Use que agem na tela (as que pedem aprovação por app). */
const ACTING_TOOLS = new Set(["cu_computer", "cu_batch"])

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscribed && typeof window !== "undefined" && window.ipcRenderer) {
    subscribed = true
    const notify = () => listeners.forEach((l) => l())
    // Depois de um reload do renderer, o main ainda pode estar controlando.
    void computerApi.activity().then((list) => {
      for (const item of list) activity.set(item.sessionId, item)
      notify()
    })
    computerApi.onEvent((event) => {
      if (event.type === "active") activity.set(event.activity.sessionId, event.activity)
      else if (event.type === "idle") activity.delete(event.sessionId)
      notify()
    })
  }
  return () => listeners.delete(listener)
}

/** A atividade de controle desta conversa, com um tique por segundo para o relógio. */
export function useComputerActivity(sessionId: string | undefined): ComputerActivity | undefined {
  const [, setTick] = useState(0)
  useEffect(() => subscribe(() => setTick((v) => v + 1)), [])
  const entry = sessionId ? activity.get(sessionId) : undefined
  useEffect(() => {
    if (!entry) return
    const timer = setInterval(() => setTick((v) => v + 1), 1_000)
    return () => clearInterval(timer)
  }, [entry])
  return entry
}

function elapsed(since: number): string {
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`
}

/**
 * Por que abrir sozinho, agora: a chave identifica o momento (o pedido, ou o
 * resultado que mandou parar), para que fechar uma vez não reabra no mesmo.
 */
function useAutoOpenReason(sessionId: string | undefined): { key: string; kind: "approval" | "stalled" } | null {
  const approval = useSessionStore((state) =>
    sessionId
      ? state.pendingAsks[sessionId]?.find((ask) => ask.kind === "permission" && ask.claim && ACTING_TOOLS.has(ask.claim.tool))?.requestId
      : undefined,
  )
  const stalled = useSessionStore((state) => {
    if (!sessionId) return undefined
    const last = state.messages[sessionId]?.at(-1)
    if (!last || last.role !== "assistant") return undefined
    for (let i = last.parts.length - 1; i >= 0; i--) {
      const part = last.parts[i]
      if (part.type !== "tool") continue
      if (!part.tool.startsWith("cu_")) return undefined
      return part.output?.includes("STOP: ") ? part.id : undefined
    }
    return undefined
  })
  if (approval) return { key: approval, kind: "approval" }
  if (stalled) return { key: stalled, kind: "stalled" }
  return null
}

export function ComputerChip({ sessionId, className }: { sessionId?: string; className?: string }) {
  const { t } = useTranslation()
  const entry = useComputerActivity(sessionId)
  const pinnedAbove = useComputerThumbPin((state) => (sessionId ? state.pinned[sessionId] === true : false))
  const [held, setHeld] = useState(false)
  const [peek, setPeek] = useState(false)
  const [autoKey, setAutoKey] = useState<string | null>(null)
  const dismissed = useRef(new Set<string>())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reason = useAutoOpenReason(entry ? sessionId : undefined)

  // Abre sozinho num momento novo; o momento que passou (aprovação respondida) fecha o que ele abriu.
  useEffect(() => {
    if (reason && !dismissed.current.has(reason.key) && !pinnedAbove) setAutoKey(reason.key)
    else if (!reason) setAutoKey(null)
  }, [reason, pinnedAbove])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  // O controle acabou: nada fica aberto para a próxima vez.
  useEffect(() => {
    if (entry) return
    setHeld(false)
    setPeek(false)
    setAutoKey(null)
  }, [entry])

  if (!sessionId || !entry) return null
  const label = t("computer.chip.controlling", { app: entry.app })
  // Fixado acima da mensagem, o popover seria a mesma imagem duas vezes.
  const open = !pinnedAbove && (held || peek || autoKey !== null)

  const schedule = (next: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setPeek(next), ms)
  }
  const hover = {
    onMouseEnter: () => schedule(true, PEEK_OPEN_MS),
    onMouseLeave: () => schedule(false, PEEK_CLOSE_MS),
  }
  const closeAll = () => {
    if (autoKey) dismissed.current.add(autoKey)
    setHeld(false)
    setPeek(false)
    setAutoKey(null)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next) {
          if (details.reason === "trigger-press") setHeld(true)
          return
        }
        // Clique no chip com o popover só espiando: fixa em vez de fechar.
        if (details.reason === "trigger-press" && !held && peek) {
          setHeld(true)
          return
        }
        closeAll()
      }}
    >
      <div
        {...hover}
        title={entry.lastAction ?? label}
        className={cn(
          // Amarelo primário do Orbit; o texto fica no foreground porque amarelo
          // sobre fundo claro não se lê.
          "inline-flex max-w-full items-center gap-1.5 self-center rounded-full border border-primary/60 bg-primary/10 py-0.5 pl-0.5 pr-0.5 text-[11px] font-medium text-foreground shadow-sm backdrop-blur",
          className,
        )}
      >
        <PopoverTrigger
          aria-label={t("computer.thumb.openTitle", { app: entry.app })}
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pl-2 pr-1 transition-colors hover:bg-primary/15 focus-visible:outline-2 focus-visible:outline-primary"
        >
          <MonitorIcon className="size-3.5 shrink-0 text-primary-foreground dark:text-primary" />
          <Shimmer className="hidden max-w-40 truncate @lg:inline-block">{label}</Shimmer>
          <span className="font-mono tabular-nums text-muted-foreground">{elapsed(entry.startedAt)}</span>
          <ChevronDownIcon className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </PopoverTrigger>
        <button
          type="button"
          aria-label={t("computer.chip.stopTitle", { shortcut: computerStopShortcut(windowApi.platform) })}
          onClick={() => void computerApi.stop(sessionId)}
          className="inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-primary-foreground transition-colors hover:bg-primary/85"
        >
          <SquareIcon className="size-2.5 fill-current" />
          {t("computer.chip.stop")}
        </button>
      </div>
      <PopoverContent
        align="end"
        sideOffset={6}
        initialFocus={false}
        className="w-96 p-3"
        {...hover}
      >
        <ComputerThumbBody
          sessionId={sessionId}
          entry={entry}
          notice={autoKey && reason?.key === autoKey ? reason.kind : null}
          onPin={() => {
            useComputerThumbPin.getState().setPinned(sessionId, true)
            closeAll()
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** O conteúdo comum ao popover e ao card fixado: cabeçalho, imagem, última ação e ações. */
function ComputerThumbBody({
  sessionId,
  entry,
  notice,
  onPin,
  onUnpin,
  compact,
}: {
  sessionId: string
  entry: ComputerActivity
  notice?: "approval" | "stalled" | null
  onPin?: () => void
  onUnpin?: () => void
  compact?: boolean
}) {
  const { t } = useTranslation()
  const shot = useComputerShot(sessionId)
  const app = shot?.app ?? entry.app
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <Truncate text={app}>
          <span className="truncate">{app}</span>
        </Truncate>
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          {t("computer.thumb.live")}
          {onUnpin && (
            <Hint label={t("computer.thumb.unpin")}>
              <button
                type="button"
                onClick={onUnpin}
                aria-label={t("computer.thumb.unpin")}

                className="ml-1 inline-flex size-6 items-center justify-center rounded-md hover:bg-muted"
              >
                <XIcon className="size-3.5" />
              </button>
            </Hint>
          )}
        </span>
      </div>
      {notice && (
        <p className="rounded-md bg-primary/10 px-2 py-1.5 text-xs text-foreground">
          {notice === "approval" ? t("computer.thumb.awaiting", { app }) : t("computer.thumb.stalled")}
        </p>
      )}
      {shot ? (
        <ComputerShotImage shot={shot} />
      ) : (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">{t("computer.thumb.noShot")}</p>
      )}
      {entry.lastAction && <Truncate text={t("computer.thumb.last", { action: entry.lastAction })}>
        <p className="truncate text-[11px] text-muted-foreground">{t("computer.thumb.last", { action: entry.lastAction })}</p>
      </Truncate>}
      {!compact && (
        <div className="flex gap-2">
          {onPin && (
            <button
              type="button"
              onClick={onPin}
              className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border bg-background text-xs transition-colors hover:bg-muted"
            >
              <PinIcon className="size-3.5" />
              {t("computer.thumb.pin")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void computerApi.focusApp(sessionId)}
            className="inline-flex h-8 flex-1 items-center justify-center rounded-md border bg-background text-xs transition-colors hover:bg-muted"
          >
            {t("computer.thumb.focus", { app })}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * O card fixado acima do campo de mensagem ("Fixar acima da mensagem" do
 * popover). Some quando o controle termina, e a fixação vai junto: a próxima
 * tarefa volta a começar pelo chip.
 */
export function ComputerThumbCard({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const entry = useComputerActivity(sessionId)
  const pinned = useComputerThumbPin((state) => (sessionId ? state.pinned[sessionId] === true : false))
  const setPinned = useComputerThumbPin((state) => state.setPinned)

  useEffect(() => {
    if (sessionId && pinned && !entry) setPinned(sessionId, false)
  }, [sessionId, pinned, entry, setPinned])

  if (!sessionId || !entry || !pinned) return null
  return (
    <div className="mx-auto flex w-full max-w-2xl justify-end px-1 pb-2">
      <section aria-label={t("computer.thumb.openTitle", { app: entry.app })} className="w-72 rounded-xl border bg-popover p-2.5 shadow-md">
        <ComputerThumbBody sessionId={sessionId} entry={entry} compact onUnpin={() => setPinned(sessionId, false)} />
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            onClick={() => void computerApi.focusApp(sessionId)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t("computer.thumb.focus", { app: entry.app })}
          </button>
        </div>
      </section>
    </div>
  )
}
