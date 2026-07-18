import { useState } from "react"
import { Bot, ChevronLeft, ChevronRight, ChevronDown, HelpCircle, ShieldAlert, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { Question } from "@shared/chat"
import { chatApi } from "@/src/lib/ipc"
import type { PendingAskUI } from "@/src/stores/session-store"

function OriginBadge({ workerTitle }: { workerTitle: string }) {
  return (
    <Badge variant="outline" className="gap-1 px-1.5 py-0 text-[10px] text-muted-foreground">
      <Bot className="size-3" /> worker: {workerTitle}
    </Badge>
  )
}

function PermissionBody({ ask, submitted, onReply }: {
  ask: PendingAskUI
  submitted: boolean
  onReply: (value: unknown) => void
}) {
  const claim = ask.claim!
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="flex items-start gap-2">
        {claim.critical ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-xs">{claim.title}</p>
          {claim.detail && (
            <p className={cn("text-xs", claim.critical ? "text-destructive" : "text-muted-foreground")}>
              {claim.critical ? "Ação crítica: " : ""}{claim.detail}
            </p>
          )}
        </div>
        {ask.origin && <OriginBadge workerTitle={ask.origin.workerTitle} />}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={submitted} onClick={() => onReply("deny")}>
          Negar
        </Button>
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger render={<Button size="sm" disabled={submitted} />}>
            Permitir
            <ChevronDown className="ml-1 size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => { setOpen(false); onReply("allow") }}>
              Uma vez
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setOpen(false); onReply("always_chat") }}>
              Sempre neste chat
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setOpen(false); onReply("always") }}>
              Sempre
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-sm">{question.text}</p>
      {question.options && question.options.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant={selected.has(option) ? "secondary" : "outline"}
              className="h-7 text-xs"
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
        placeholder="Outra resposta…"
        className="h-7 text-xs"
      />
    </div>
  )
}

function QuestionBody({ ask, submitted, onReply }: {
  ask: PendingAskUI
  submitted: boolean
  onReply: (value: unknown) => void
}) {
  const questions = ask.questions ?? []
  const [currentIndex, setCurrentIndex] = useState(0)
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [free, setFree] = useState<Record<string, string>>({})

  const answerOf = (q: Question): string => {
    const picks = [...(selected[q.id] ?? [])]
    const text = free[q.id]?.trim()
    if (text) picks.push(text)
    return picks.join(", ")
  }
  const allAnswered = questions.every((q) => answerOf(q).length > 0)
  const current = questions[currentIndex]

  return (
    <>
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              Pergunta {currentIndex + 1} de {questions.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                disabled={currentIndex === 0}
                onClick={() => setCurrentIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <button
                type="button"
                className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground disabled:opacity-30"
                disabled={currentIndex >= questions.length - 1}
                onClick={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
              >
                <ChevronRight className="size-3.5" />
              </button>
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
        {ask.origin && <OriginBadge workerTitle={ask.origin.workerTitle} />}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={submitted}
          onClick={() => onReply({ rejected: true })}
        >
          Dispensar
        </Button>
        <Button
          size="sm"
          disabled={submitted || !allAnswered}
          onClick={() => onReply({ answers: questions.map(answerOf) })}
        >
          Responder
        </Button>
      </div>
    </>
  )
}

export function AskCard({ ask }: { ask: PendingAskUI }) {
  const [submitted, setSubmitted] = useState(false)
  const reply = (value: unknown) => {
    setSubmitted(true)
    void chatApi.askReply(ask.requestId, value)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      {ask.kind === "permission" ? (
        <PermissionBody ask={ask} submitted={submitted} onReply={reply} />
      ) : (
        <QuestionBody ask={ask} submitted={submitted} onReply={reply} />
      )}
    </div>
  )
}
