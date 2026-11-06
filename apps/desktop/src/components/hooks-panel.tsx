import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Ban, Pencil, PenLine, Power, PowerOff, Trash2, Wand2, Webhook } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { AskOrbitDialog } from "@/src/components/ask-orbit-dialog"
import { CardMenu } from "@/src/components/card-menu"
import { CreateMenu } from "@/src/components/create-menu"
import { hooksApi } from "@/src/lib/ipc"
import type { HookEvent, HookInput, HookRun, HookWithRun } from "@shared/hooks"
import { hookMatcher } from "@shared/hooks"

/**
 * Tools → Hooks page: the list of the user's shell hooks, with the last run of each.
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

function HookForm({ initial, draft, onDone }: {
  initial?: HookWithRun
  /** Suggestion from "ask Orbit": a NEW hook to review, never saved before the user confirms. */
  draft?: HookInput
  onDone: () => void
}) {
  const { t } = useTranslation()
  const { folders } = useWorkspace()
  const seed = initial ?? draft
  const [event, setEvent] = useState<HookEvent>(seed?.event ?? "pre_tool_call")
  const [match, setMatch] = useState(seed?.match ?? "")
  const [command, setCommand] = useState(seed?.command ?? "")
  const [description, setDescription] = useState(seed?.description ?? "")
  const [scope, setScope] = useState(initial?.directory ?? GLOBAL)
  const [timeout, setTimeoutValue] = useState(seed?.timeoutMs ? String(seed.timeoutMs / 1000) : "")
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
      {draft && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          {t("askOrbit.hooks.review")}
        </p>
      )}
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

export function HooksPanel({ query = "" }: { query?: string }) {
  const { t } = useTranslation()
  const [hooks, setHooks] = useState<HookWithRun[]>([])
  // undefined = list; null = new hook; a hook = editing it
  const [editing, setEditing] = useState<HookWithRun | null | undefined>(undefined)
  // Suggestion from "ask Orbit" being reviewed in the form of a new hook.
  const [draft, setDraft] = useState<HookInput | undefined>()
  const [askOpen, setAskOpen] = useState(false)

  const refresh = useCallback(() => {
    void hooksApi.list().then(setHooks)
  }, [])

  useEffect(() => {
    refresh()
    // The last run changes with every tool call; a light poll while the page is open
    // is cheaper than an event per call for a screen almost nobody has open.
    const timer = setInterval(refresh, 4_000)
    const listener = window.ipcRenderer.on("hooks:changed", refresh)
    return () => {
      clearInterval(timer)
      window.ipcRenderer.off("hooks:changed", listener)
    }
  }, [refresh])

  const needle = query.trim().toLowerCase()
  const visibleHooks = needle
    ? hooks.filter((hook) =>
        [hook.description, hook.command, hook.match, hook.directory ? folderName(hook.directory) : ""].some((field) =>
          field?.toLowerCase().includes(needle),
        ),
      )
    : hooks

  const done = () => {
    setEditing(undefined)
    setDraft(undefined)
    refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t("hooks.title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("hooks.description")}</p>
        </div>
        <CreateMenu
          label={t("hooks.add")}
          options={[
            {
              id: "ask",
              icon: Wand2,
              title: t("askOrbit.menu.hooks.title"),
              description: t("askOrbit.menu.hooks.description"),
              onSelect: () => setAskOpen(true),
            },
            {
              id: "manual",
              icon: PenLine,
              title: t("askOrbit.menu.manual"),
              description: t("askOrbit.menu.hooks.manualDescription"),
              onSelect: () => { setDraft(undefined); setEditing(null) },
            },
          ]}
        />
      </div>

      {hooks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
          <Webhook className="size-6 text-muted-foreground/50" />
          <p className="text-xs text-muted-foreground">{t("hooks.empty")}</p>
        </div>
      ) : visibleHooks.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-xs text-muted-foreground">
          {t("toolsPage.noResults", { query: query.trim() })}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {visibleHooks.map((hook) => (
            <div key={hook.id} className={cn("flex items-start gap-3 rounded-lg border bg-card p-3", !hook.enabled && "opacity-70")}>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium">{t(`hooks.event.${hook.event}`)}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{hook.match === "*" ? t("hooks.anyTool") : hook.match}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {hook.directory ? folderName(hook.directory) : t("hooks.scope.global")}
                  </span>
                  {!hook.enabled && (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">{t("hooks.disabled")}</span>
                  )}
                  {hook.createdBy === "agent" && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("hooks.byAgent")}</span>
                  )}
                  {hook.lastRun?.blocked && hook.event === "pre_tool_call" && <Ban className="size-3 text-amber-500" />}
                </div>
                {hook.description && <p className="mt-1 text-sm">{hook.description}</p>}
                <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">$ {hook.command}</pre>
                {hook.lastRun ? <LastRun run={hook.lastRun} /> : <p className="mt-1.5 text-[10px] text-muted-foreground">{t("hooks.run.never")}</p>}
              </div>
              <CardMenu
                items={[
                  { id: "edit", label: t("common.edit"), icon: Pencil, onSelect: () => setEditing(hook) },
                  {
                    id: "toggle",
                    label: hook.enabled ? t("hooks.menu.disable") : t("hooks.menu.enable"),
                    icon: hook.enabled ? PowerOff : Power,
                    onSelect: () => void hooksApi.toggle(hook.id, !hook.enabled).then(refresh),
                  },
                  {
                    id: "remove",
                    label: t("common.remove"),
                    icon: Trash2,
                    destructive: true,
                    onSelect: () => void hooksApi.remove(hook.id).then(refresh),
                  },
                ]}
              />
            </div>
          ))}
        </div>
      )}
      {/* Creating (by hand or from a suggestion of Orbit) and editing happen in a modal; the
          form mounts only while it is open, so every opening starts from its own hook. */}
      <Dialog open={editing !== undefined} onOpenChange={(open) => { if (!open) done() }}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? t("hooks.editTitle") : t("hooks.newTitle")}</DialogTitle>
            <DialogDescription>{t("hooks.description")}</DialogDescription>
          </DialogHeader>
          {editing !== undefined && <HookForm initial={editing ?? undefined} draft={draft} onDone={done} />}
        </DialogContent>
      </Dialog>
      <AskOrbitDialog
        kind="hooks"
        open={askOpen}
        onOpenChange={setAskOpen}
        generate={hooksApi.generate}
        onGenerated={(suggestion: HookInput) => { setDraft(suggestion); setEditing(null) }}
      />
    </div>
  )
}
