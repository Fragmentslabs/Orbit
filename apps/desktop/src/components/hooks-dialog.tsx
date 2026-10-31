import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft, Ban, Pencil, PlusIcon, Trash2, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { hooksApi } from "@/src/lib/ipc"
import type { HookEvent, HookInput, HookRun, HookWithRun } from "@shared/hooks"
import { hookMatcher } from "@shared/hooks"

/**
 * Tools → Hooks: the list of the user's shell hooks, with the last run of each.
 * The last run is what makes the list worth opening — "why can't the agent
 * commit?" has its answer here ("blocked by the hook X at 14:02").
 */

const GLOBAL = "__global__"

function folderName(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).pop() ?? dir
}

function LastRun({ run }: { run: HookRun }) {
  const { t } = useTranslation()
  const time = new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  const status = run.timedOut
    ? t("hooks.run.timedOut")
    : run.blocked
      ? t("hooks.run.blocked")
      : run.exitCode === 0
        ? t("hooks.run.ok")
        : t("hooks.run.failed", { code: run.exitCode ?? "?" })
  return (
    <div className="mt-1.5 text-[10px] text-muted-foreground">
      <span className={cn(run.blocked && "text-amber-500", (run.timedOut || (run.exitCode !== 0 && !run.blocked)) && "text-destructive")}>
        {status}
      </span>
      {" · "}
      {t("hooks.run.on", { tool: run.tool, time, ms: run.ms })}
      {run.output && (
        <pre className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap break-all rounded bg-muted/60 px-1.5 py-1 font-mono">{run.output}</pre>
      )}
    </div>
  )
}

function HookForm({ initial, onDone }: { initial?: HookWithRun; onDone: () => void }) {
  const { t } = useTranslation()
  const { folders } = useWorkspace()
  const [event, setEvent] = useState<HookEvent>(initial?.event ?? "pre_tool_call")
  const [match, setMatch] = useState(initial?.match ?? "")
  const [command, setCommand] = useState(initial?.command ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [scope, setScope] = useState(initial?.directory ?? GLOBAL)
  const [timeout, setTimeoutValue] = useState(initial?.timeoutMs ? String(initial.timeoutMs / 1000) : "")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const scopes = initial?.directory && !folders.includes(initial.directory) ? [initial.directory, ...folders] : folders
  const matchInvalid = match.trim() !== "" && !hookMatcher(match)

  const save = async () => {
    const seconds = Number(timeout)
    const input: HookInput = {
      event,
      match,
      command,
      ...(description.trim() ? { description } : {}),
      ...(scope !== GLOBAL ? { directory: scope } : {}),
      ...(timeout && seconds > 0 ? { timeoutMs: seconds * 1000 } : {}),
    }
    setSaving(true)
    setError(null)
    try {
      if (initial) await hooksApi.update(initial.id, input)
      else await hooksApi.add(input)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-xs font-medium">{t("hooks.form.event")}</p>
          <Select value={event} onValueChange={(v) => setEvent((v ?? "pre_tool_call") as HookEvent)}>
            <SelectTrigger className="w-full"><SelectValue>{t(`hooks.event.${event}`)}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="pre_tool_call">{t("hooks.event.pre_tool_call")}</SelectItem>
              <SelectItem value="post_tool_call">{t("hooks.event.post_tool_call")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">{t("hooks.form.match")}</p>
          <Input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="bash, edit|write, *" className={cn("font-mono", matchInvalid && "border-destructive")} />
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium">{t("hooks.form.command")}</p>
        <Textarea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={'npx prettier --write "$ORBIT_FILE"'}
          className="min-h-20 font-mono text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          {event === "pre_tool_call" ? t("hooks.form.commandHintPre") : t("hooks.form.commandHintPost")}
        </p>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium">{t("hooks.form.description")}</p>
        <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("hooks.form.descriptionPlaceholder")} />
      </div>
      <div className="grid grid-cols-[1fr_8rem] gap-3">
        <div>
          <p className="mb-1 text-xs font-medium">{t("hooks.form.scope")}</p>
          <Select value={scope} onValueChange={(v) => setScope(v ?? GLOBAL)}>
            <SelectTrigger className="w-full">
              <SelectValue>{scope === GLOBAL ? t("hooks.scope.global") : folderName(scope)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={GLOBAL}>{t("hooks.scope.global")}</SelectItem>
              {scopes.map((dir) => (
                <SelectItem key={dir} value={dir}>{folderName(dir)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">{t("hooks.form.timeout")}</p>
          <Input type="number" min={1} max={60} value={timeout} onChange={(e) => setTimeoutValue(e.target.value)} placeholder="10" />
        </div>
      </div>
      <p className="-mt-1 text-[10px] text-muted-foreground">{t("hooks.form.timeoutHint")}</p>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onDone}>{t("common.cancel")}</Button>
        <Button disabled={!command.trim() || matchInvalid || saving} onClick={() => void save()}>
          {initial ? t("common.save") : t("common.add")}
        </Button>
      </div>
    </div>
  )
}

export function HooksDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation()
  const [hooks, setHooks] = useState<HookWithRun[]>([])
  // undefined = list; null = new hook; a hook = editing it
  const [editing, setEditing] = useState<HookWithRun | null | undefined>(undefined)

  const refresh = useCallback(() => {
    void hooksApi.list().then(setHooks)
  }, [])

  useEffect(() => {
    if (!open) {
      setEditing(undefined)
      return
    }
    refresh()
    // The last run changes with every tool call; a light poll while the list is open
    // is cheaper than an event per call for a screen almost nobody has open.
    const timer = setInterval(refresh, 4_000)
    const listener = window.ipcRenderer.on("hooks:changed", refresh)
    return () => {
      clearInterval(timer)
      window.ipcRenderer.off("hooks:changed", listener)
    }
  }, [open, refresh])

  const done = () => {
    setEditing(undefined)
    refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {editing !== undefined && (
              <Button size="icon-sm" variant="ghost" onClick={() => setEditing(undefined)} aria-label={t("common.back")}>
                <ArrowLeft className="size-4" />
              </Button>
            )}
            {editing === undefined ? t("hooks.title") : editing ? t("hooks.editTitle") : t("hooks.newTitle")}
          </DialogTitle>
          <DialogDescription>{t("hooks.description")}</DialogDescription>
        </DialogHeader>

        {editing !== undefined ? (
          <HookForm initial={editing ?? undefined} onDone={done} />
        ) : (
          <>
            <div className="flex justify-end">
              <Button size="sm" className="gap-1" onClick={() => setEditing(null)}>
                <PlusIcon className="size-3.5" />
                {t("hooks.add")}
              </Button>
            </div>
            {hooks.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
                <Webhook className="size-6 text-muted-foreground/50" />
                <p className="text-xs text-muted-foreground">{t("hooks.empty")}</p>
              </div>
            ) : (
              <ScrollArea className="max-h-[60vh] pr-3">
                <div className="flex flex-col gap-2">
                  {hooks.map((hook) => (
                    <div key={hook.id} className={cn("flex items-start gap-3 rounded-lg border p-3", !hook.enabled && "opacity-60")}>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">{t(`hooks.event.${hook.event}`)}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{hook.match === "*" ? t("hooks.anyTool") : hook.match}</span>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {hook.directory ? folderName(hook.directory) : t("hooks.scope.global")}
                          </span>
                          {hook.createdBy === "agent" && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("hooks.byAgent")}</span>
                          )}
                          {hook.lastRun?.blocked && hook.event === "pre_tool_call" && <Ban className="size-3 text-amber-500" />}
                        </div>
                        {hook.description && <p className="mt-1 text-sm">{hook.description}</p>}
                        <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">$ {hook.command}</pre>
                        {hook.lastRun ? <LastRun run={hook.lastRun} /> : <p className="mt-1.5 text-[10px] text-muted-foreground">{t("hooks.run.never")}</p>}
                      </div>
                      <div className="flex items-center gap-1 self-start pt-0.5">
                        <Switch
                          checked={hook.enabled}
                          onCheckedChange={(enabled) => void hooksApi.toggle(hook.id, enabled).then(refresh)}
                          aria-label={t("hooks.toggle")}
                        />
                        <Hint label={t("common.edit")}>
                          <Button size="icon-sm" variant="ghost" onClick={() => setEditing(hook)}>
                            <Pencil className="size-3.5" />
                          </Button>
                        </Hint>
                        <Hint label={t("common.remove")}>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => void hooksApi.remove(hook.id).then(refresh)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </Hint>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
