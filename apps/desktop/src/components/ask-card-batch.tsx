import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, ChevronDown, HelpCircle, Layers, ShieldAlert, TriangleAlert } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { Question } from "@shared/chat"
import { chatApi } from "@/src/lib/ipc"
import { QuestionItem } from "@/src/components/ask-card"
import type { PendingAskUI } from "@/src/stores/session-store"

type PermissionDecision = "allow" | "always_chat" | "always" | "deny"

const PERMIT_OPTIONS: { value: PermissionDecision; labelKey: string }[] = [
  { value: "allow", labelKey: "permissions.once" },
  { value: "always_chat", labelKey: "permissions.alwaysChat" },
  { value: "always", labelKey: "permissions.always" },
]

function BatchPermissionBlock({ item, choice, onChoice }: {
  item: PendingAskUI
  choice: PermissionDecision
  onChoice: (value: PermissionDecision) => void
}) {
  const { t } = useTranslation()
  const claim = item.claim!
  const [, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2">
        {claim.critical ? (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
        ) : (
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        )}
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-xs">{claim.title}</p>
          {claim.detail && (
            <p className={cn("whitespace-pre-wrap break-words text-xs", claim.critical ? "text-destructive" : "text-muted-foreground")}>
              {claim.critical ? `${t("ask.critical")}` : ""}{claim.detail}
            </p>
          )}
        </div>
        <DropdownMenu onOpenChange={setOpen}>
          <DropdownMenuTrigger render={<Button size="sm" variant="outline" className="gap-1 text-xs h-7" />}>
            {PERMIT_OPTIONS.find((o) => o.value === choice)?.labelKey
              ? t(PERMIT_OPTIONS.find((o) => o.value === choice)!.labelKey)
              : t("permissions.allow")}
            <ChevronDown className="size-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {PERMIT_OPTIONS.map((opt) => (
              <DropdownMenuItem key={opt.value} onClick={() => onChoice(opt.value)}>
                {t(opt.labelKey)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function AskCardBatch({ items }: { items: PendingAskUI[] }) {
  const { t } = useTranslation()
  const [submitted, setSubmitted] = useState(false)
  const [permChoices, setPermChoices] = useState<Record<string, PermissionDecision>>({})
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [free, setFree] = useState<Record<string, string>>({})

  const keyOf = (requestId: string, questionId: string) => `${requestId}:${questionId}`
  const answerOf = (requestId: string, q: Question): string => {
    const key = keyOf(requestId, q.id)
    const picks = [...(selected[key] ?? [])]
    const text = free[key]?.trim()
    if (text) picks.push(text)
    return picks.join(", ")
  }
  const allAnswered = items.every(
    (item) =>
      item.kind === "permission" ||
      (item.questions ?? []).every((q) => answerOf(item.requestId, q).length > 0),
  )

  const replyAll = (dismiss: boolean) => {
    setSubmitted(true)
    for (const item of items) {
      if (item.kind === "permission") {
        void chatApi.askReply(item.requestId, dismiss ? "deny" : permChoices[item.requestId] ?? "allow")
      } else {
        void chatApi.askReply(
          item.requestId,
          dismiss
            ? { rejected: true }
            : { answers: (item.questions ?? []).map((q) => answerOf(item.requestId, q)) },
        )
      }
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-sm">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Layers className="size-3.5" />
        {t("ask.batchWaiting", { count: items.length })}
      </div>
      {items.map((item) => (
        <div key={item.requestId} className="flex flex-col gap-2 rounded-md border bg-background/50 p-2.5">
          <Badge variant="outline" className="w-fit gap-1 px-1.5 py-0 text-[10px] text-muted-foreground">
            <Bot className="size-3" /> {item.origin?.workerTitle ?? t("ask.worker")}
          </Badge>
          {item.kind === "permission" ? (
            <BatchPermissionBlock
              item={item}
              choice={permChoices[item.requestId] ?? "allow"}
              onChoice={(value) =>
                setPermChoices((prev) => ({ ...prev, [item.requestId]: value }))
              }
            />
          ) : (
            <div className="flex items-start gap-2">
              <HelpCircle className="mt-0.5 size-4 shrink-0 text-primary" />
              <div className="flex min-w-0 flex-1 flex-col gap-3">
                {(item.questions ?? []).map((q) => (
                  <QuestionItem
                    key={q.id}
                    question={q}
                    selected={selected[keyOf(item.requestId, q.id)] ?? new Set()}
                    free={free[keyOf(item.requestId, q.id)] ?? ""}
                    onToggle={(option) =>
                      setSelected((prev) => {
                        const key = keyOf(item.requestId, q.id)
                        const next = new Set(prev[key] ?? [])
                        if (next.has(option)) next.delete(option)
                        else {
                          if (!q.multi) next.clear()
                          next.add(option)
                        }
                        return { ...prev, [key]: next }
                      })
                    }
                    onFree={(text) =>
                      setFree((prev) => ({ ...prev, [keyOf(item.requestId, q.id)]: text }))
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={submitted} onClick={() => replyAll(true)}>
          {t("ask.dismissAll")}
        </Button>
        <Button size="sm" disabled={submitted || !allAnswered} onClick={() => replyAll(false)}>
          {t("ask.answerAll")}
        </Button>
      </div>
    </div>
  )
}
