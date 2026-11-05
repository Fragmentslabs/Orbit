import type { TFunction } from "i18next"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, ChevronLeft, ChevronRight, ChevronDown, HelpCircle, MessageSquare, MessagesSquare, ShieldAlert, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Question } from "@shared/chat"
import { formatAskAnswer } from "@shared/chat"
import type { Pipeline } from "@shared/pipeline"
import { TaskPlanDialog } from "@/src/components/pipeline/task-plan-dialog"
import { usePipelineStore } from "@/src/stores/pipeline-store"
import { chatApi } from "@/src/lib/ipc"
import { usePanelStore } from "@/src/stores/panel-store"
import { useSessionStore } from "@/src/stores/session-store"
import type { PendingAskUI } from "@/src/stores/session-store"
import { sessionModelFor, useSessionModelPrefs } from "@/src/stores/session-model-prefs"
import { Hint } from "@/components/ui/hint"

function OriginBadge({ workerTitle, t }: { workerTitle: string; t: (key: string) => string }) {
  return (
    <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] text-muted-foreground">
      <Bot className="size-3" /> {t("ask.worker")}: {workerTitle}
    </Badge>
  )
}

function PermissionBody({ ask, submitted, onReply }: {
  ask: PendingAskUI
  submitted: boolean
  onReply: (value: unknown) => void
}) {
  const { t } = useTranslation()
  const claim = ask.claim!
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex items-start gap-2">
        {claim.critical ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-xs">{claim.title}</p>
          {claim.detail && (
            <p className={cn("whitespace-pre-wrap break-words text-xs", claim.critical ? "text-destructive" : "text-muted-foreground")}>
              {claim.critical ? `${t("ask.critical")}` : ""}{claim.detail}
            </p>
          )}
          {claim.learned && (
            <p className="mt-1 text-[11px] leading-tight text-muted-foreground/80">
              {t("permissions.learned", { count: claim.learned.count })}
            </p>
          )}
        </div>
        {ask.origin && <OriginBadge workerTitle={ask.origin.workerTitle} t={t} />}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={submitted} onClick={() => onReply("deny")}>
          {t("permissions.deny")}
        </Button>
        {/* Split button: the common case (this time only) in one click; the arrow
            opens the durable permissions, which ask for a conscious choice. */}
        <div className="flex">
          <Button size="sm" className="rounded-r-none" disabled={submitted} onClick={() => onReply("allow")}>
            {t("permissions.allowOnce")}
          </Button>
          <DropdownMenu open={open} onOpenChange={setOpen}>
            {/* The arrow is a child of the button INSIDE `render`: with the icon on the
                trigger's own children (and a wrapper in `render`) Base UI keeps the
                wrapper's children and drops it — no chevron and no click to open. */}
            <DropdownMenuTrigger
              aria-label={t("permissions.moreOptions")}
              render={<Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-1.5" disabled={submitted} />}
            >
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { setOpen(false); onReply("always_chat") }}>
                {t("permissions.alwaysChat")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setOpen(false); onReply("always") }}>
                {t("permissions.always")}
                {claim.learned && (
                  <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px] text-primary">
                    {t("permissions.recommended")}
                  </Badge>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </>
  )
}

export function QuestionItem({ question, selected, free, onToggle, onFree }: {
  question: Question
  selected: Set<string>
  free: string
  onToggle: (option: string) => void
  onFree: (text: string) => void
}) {
  const { t } = useTranslation()
  // The field says what the text is going to be: with an option selected it is a note
  // ABOUT it (it goes along, labeled); with none, it is the answer itself.
  const [only] = selected
  const placeholder =
    selected.size === 0
      ? t("ask.otherAnswer")
      : selected.size > 1
        ? t("ask.noteMulti")
        : t("ask.noteOn", { option: only.length > 40 ? `${only.slice(0, 39)}…` : only })
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="min-w-0 whitespace-pre-wrap break-words text-sm">{question.text}</p>
      {question.options && question.options.length > 0 && (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {question.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="outline"
              className={cn(
                "h-auto min-h-6 max-w-full whitespace-normal break-words text-left",
                selected.has(option) && "border-primary bg-primary/10 text-primary hover:bg-primary/15",
              )}
              onClick={() => onToggle(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      <Input
        value={free}
        onChange={(e) => onFree(e.target.value)}
        placeholder={placeholder}
        title={placeholder}
        className="h-7 text-xs"
      />
    </div>
  )
}

function buildComparisonPrompt(questions: Question[], currentIndex: number, t: TFunction): string {
  const current = questions[currentIndex]
  const otherLines = questions
    .filter((_, i) => i !== currentIndex)
    .map((q, i) => {
      const opts = q.options?.length ? `\n${t("ask.comparePrompt.options")}\n${q.options.map((o) => `  - ${o}`).join("\n")}` : ""
      return `### ${i + 1}. ${q.text}${opts}`
    })
  return [
    t("ask.comparePrompt.intro"),
    "",
    `## ${current.text}`,
    ...(current.options?.length ? [`\n${t("ask.comparePrompt.options")}\n${current.options.map((o) => `  - ${o}`).join("\n")}`] : []),
    ...(otherLines.length > 0
      ? ["", "---", t("ask.comparePrompt.context"), ...otherLines]
      : []),
    "",
    t("ask.comparePrompt.explain"),
  ].join("\n")
}

function DiscussInPanelButton({ questions, currentIndex, sessionId }: {
  questions: Question[]
  currentIndex: number
  /** Conversation the card is shown in — the discussion sub-chat is born nested in IT. */
  sessionId?: string
}) {
  const openChatTabWithPendingInput = usePanelStore((s) => s.openChatTabWithPendingInput)
  const createSession = useSessionStore((s) => s.createSession)
  const { t } = useTranslation()
  const [working, setWorking] = useState(false)

  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={working}
      onClick={async () => {
        setWorking(true)
        try {
          const title = t("ask.compareOptions")
          // It hangs from the conversation the card lives in — not from the worker that
          // asked: nested under a worker the new chat shows up with the worker's icon,
          // as if an agent had opened it instead of the person.
          // The mode and the folders come from that same conversation: it stays in the
          // parent's sidebar section (a code parent must not "jump" to chat when the
          // child is clicked) and the sub-agent reads the same directory to ground the
          // discussion.
          const parent = sessionId
            ? useSessionStore.getState().sessions.find((s) => s.id === sessionId)
            : undefined
          const mode = parent?.mode ?? "chat"
          const model = sessionModelFor(sessionId)
          const session = await createSession(mode, {
            setActive: false,
            title,
            parentId: sessionId,
            ...(mode === "code"
              ? { directory: parent?.directory, extraDirectories: parent?.extraDirectories }
              : {}),
          })
          // The same model as the tab the card is in: without pinning it here the child
          // fell back to the provider's global default — another model, another price,
          // another voice than the conversation being discussed.
          if (model) useSessionModelPrefs.getState().selectModel(session.id, model.providerId, model.modelId)
          openChatTabWithPendingInput(session.id, title, buildComparisonPrompt(questions, currentIndex, t))
        } finally {
          setWorking(false)
        }
      }}
    >
      <MessageSquare className="mr-1 size-3.5" />
      {t("ask.discussInPanel")}
    </Button>
  )
}

function QuestionBody({ ask, submitted, onReply, sessionId }: {
  ask: PendingAskUI
  submitted: boolean
  onReply: (value: unknown) => void
  sessionId?: string
}) {
  const { t } = useTranslation()
  const questions = ask.questions ?? []
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [free, setFree] = useState<Record<string, string>>({})

  const answerOf = (q: Question): string =>
    formatAskAnswer([...(selected[q.id] ?? [])], free[q.id], t("ask.noteLabel"))
  const allAnswered = questions.every((q) => answerOf(q).length > 0)
  const current = questions[currentIndex]

  return (
    <>
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t("ask.questionOf", { current: currentIndex + 1, total: questions.length })}
            </span>
            <div className="flex items-center gap-1">
              <Hint label={t("common.previous")}>
                <button
                  type="button"
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={currentIndex === 0}
                  onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
                >
                  <ChevronLeft className="size-3.5" />
                </button>
              </Hint>
              <Hint label={t("common.next")}>
                <button
                  type="button"
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                  disabled={currentIndex >= questions.length - 1}
                  onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </Hint>
            </div>
          </div>
          {current && (
            <QuestionItem
              key={current.id}
              question={current}
              selected={selected[current.id] ?? new Set()}
              free={free[current.id] ?? ""}
              onToggle={(option) =>
                setSelected((prev) => {
                  const next = new Set(prev[current.id] ?? [])
                  if (next.has(option)) next.delete(option)
                  else {
                    if (!current.multi) next.clear()
                    next.add(option)
                  }
                  return { ...prev, [current.id]: next }
                })
              }
              onFree={(text) => setFree((prev) => ({ ...prev, [current.id]: text }))}
            />
          )}
        </div>
        {ask.origin && <OriginBadge workerTitle={ask.origin.workerTitle} t={t} />}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="ml-6">
          <DiscussInPanelButton questions={questions} currentIndex={currentIndex} sessionId={sessionId} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={submitted}
            onClick={() => onReply({ rejected: true })}
          >
            {t("ask.dismiss")}
          </Button>
          {currentIndex < questions.length - 1 ? (
            <Button
              size="sm"
              variant="outline"
              disabled={submitted}
              onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
            >
              {t("ask.advance")}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={submitted || !allAnswered}
              onClick={() => onReply({ answers: questions.map(answerOf) })}
            >
              {t("ask.answer")}
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

function SubchatBody({ ask, submitted, onReply }: {
  ask: PendingAskUI
  submitted: boolean
  onReply: (value: unknown) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const sugestao = ask.subchat ?? { title: "", brief: "" }
  // The third destination: independent, larger work goes to a pipeline, through the
  // same two-step approval as "Plan tasks" on the board.
  const pipelines = usePipelineStore((s) => s.pipelines)
  const pipelinesLoaded = usePipelineStore((s) => s.loaded)
  const loadPipelines = usePipelineStore((s) => s.load)
  const [planning, setPlanning] = useState<Pipeline | null>(null)
  useEffect(() => {
    if (!pipelinesLoaded) void loadPipelines()
  }, [pipelinesLoaded, loadPipelines])
  // A new top-level chat (conversation got long) is not a subchat: it does not nest
  // under this one, and the card says so — with a chat icon, not the two-bubble one.
  const newChat = sugestao.scope === "chat"
  return (
    <>
      <div className="flex items-start gap-2">
        {newChat ? (
          <MessageSquare className="mt-0.5 size-4 shrink-0 text-primary" />
        ) : (
          <MessagesSquare className="mt-0.5 size-4 shrink-0 text-primary" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            {t(newChat ? "ask.subchat.titleChat" : "ask.subchat.title")}
          </p>
          <p className="mt-1 break-words text-sm font-medium">{sugestao.title}</p>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {sugestao.brief}
          </p>
        </div>
        {ask.origin && <OriginBadge workerTitle={ask.origin.workerTitle} t={t} />}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={submitted} onClick={() => onReply("deny")}>
          {t("ask.subchat.deny")}
        </Button>
        {/* Button group: the default is the new chat; the arrow opens the alternative,
            which keeps the work in this conversation. */}
        <div className="flex">
          <Button size="sm" className="rounded-r-none" disabled={submitted} onClick={() => onReply("new")}>
            {t("ask.subchat.newChat")}
          </Button>
          <DropdownMenu open={open} onOpenChange={setOpen}>
            {/* Same as the permission split button: the chevron belongs to the button
                inside `render`, otherwise it is dropped and the trigger never opens. */}
            <DropdownMenuTrigger
              aria-label={t("ask.subchat.moreOptions")}
              render={<Button size="sm" className="rounded-l-none border-l border-primary-foreground/20 px-1.5" disabled={submitted} />}
            >
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { setOpen(false); onReply("here") }}>
                {t("ask.subchat.here")}
              </DropdownMenuItem>
              {pipelines.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => { setOpen(false); setPlanning(p) }}>
                  {t("ask.subchat.toPipeline", { name: p.name })}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {planning && (
        <TaskPlanDialog
          pipeline={planning}
          open
          initialRequest={`${sugestao.title}\n\n${sugestao.brief}`}
          onOpenChange={(v) => !v && setPlanning(null)}
          onCreated={(count) => onReply(`pipeline:${count}:${planning.name}`)}
        />
      )}
    </>
  )
}

export function AskCard({ ask, sessionId }: { ask: PendingAskUI; sessionId?: string }) {
  const [submitted, setSubmitted] = useState(false)
  const reply = (value: unknown) => {
    setSubmitted(true)
    void chatApi.askReply(ask.requestId, value)
  }

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      {ask.kind === "permission" ? (
        <PermissionBody ask={ask} submitted={submitted} onReply={reply} />
      ) : ask.kind === "subchat" ? (
        <SubchatBody ask={ask} submitted={submitted} onReply={reply} />
      ) : (
        <QuestionBody ask={ask} submitted={submitted} onReply={reply} sessionId={sessionId} />
      )}
    </div>
  )
}
