import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import {
  Cable,
  ChevronDown,
  ExternalLink,
  FileUp,
  FileText,
  Folder,
  KeyRound,
  LoaderCircle,
  Pencil,
  PenLine,
  PlusIcon,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace-context"
import { mcpApi, nodaraApi, skillsApi } from "@/src/lib/ipc"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useDraftInput } from "@/src/stores/draft-input"
import { useSessionStore } from "@/src/stores/session-store"
import { useSkillsStore } from "@/src/stores/skills-store"
import type { McpServerConfig } from "@shared/mcp"
import type { NodaraStatus } from "@shared/nodara"
import type { Skill } from "@shared/skills"
import nodaraLogo from "@/src/assets/nodara-logo.png"

/** Regex de slug válido: apenas minúsculas, números e underscores */
const SLUG_REGEX = /^[a-z0-9_]+$/

/* ------------------------------------------------------------------ */
/*  Key-Value editor (env / headers)                                    */
/* ------------------------------------------------------------------ */

function KvEditor({ value, onChange, keyPlaceholder, valuePlaceholder }: {
  value: Record<string, string>
  onChange: (v: Record<string, string>) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<Array<{ id: number; key: string; value: string }>>(() => [])
  const idRef = useRef(0)
  const valueJsonRef = useRef("")

  // Sincroniza do pai apenas quando o valor externo muda de verdade
  // (não quando nós mesmos emitimos a mudança via onChange)
  useEffect(() => {
    const json = JSON.stringify(value)
    if (json === valueJsonRef.current) return
    valueJsonRef.current = json
    const fromParent = Object.entries(value)
    if (fromParent.length === 0) {
      setItems([{ id: ++idRef.current, key: "", value: "" }])
    } else {
      setItems(fromParent.map(([k, v]) => ({ id: ++idRef.current, key: k, value: v })))
    }
  }, [value])

  const emit = (next: Array<{ key: string; value: string }>) => {
    const result: Record<string, string> = {}
    for (const { key, value } of next) {
      if (key.trim() && value.trim()) result[key.trim()] = value
    }
    valueJsonRef.current = JSON.stringify(result)
    onChange(result)
  }

  const update = (index: number, field: "key" | "value", newVal: string) => {
    setItems((prev) => {
      const next = prev.map((item, i) => (i === index ? { ...item, [field]: newVal } : item))
      emit(next)
      return next
    })
  }

  const remove = (index: number) => {
    setItems((prev) => {
      const next = prev.filter((_, i) => i !== index)
      emit(next.length === 0 ? [{ key: "", value: "" }] : next)
      return next.length === 0 ? [{ id: ++idRef.current, key: "", value: "" }] : prev.filter((_, i) => i !== index)
    })
  }

  const add = () => {
    setItems((prev) => [...prev, { id: ++idRef.current, key: "", value: "" }])
  }

  return (
    <div className="flex flex-col gap-1">
      {items.map((item, index) => (
        <div key={item.id} className="flex items-center gap-1">
          <Input
            value={item.key}
            onChange={(e) => update(index, "key", e.target.value)}
            placeholder={keyPlaceholder ?? t("mcp.kv.key")}
            className="h-7 w-[140px] text-xs"
          />
          <Input
            value={item.value}
            onChange={(e) => update(index, "value", e.target.value)}
            placeholder={valuePlaceholder ?? t("mcp.kv.value")}
            className="h-7 flex-1 text-xs"
          />
          <button
            type="button"
            onClick={() => remove(index)}
            className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex h-7 items-center gap-1 rounded border border-dashed px-2 text-[11px] text-muted-foreground hover:border-solid hover:text-foreground"
      >
        <PlusIcon className="size-3" />
        {t("mcp.kv.add")}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Dialog: Adicionar / Editar Servidor MCP                            */
/* ------------------------------------------------------------------ */

function McpServerDialog({ open, onOpenChange, initial }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: McpServerConfig
}) {
  const { t } = useTranslation()
  const refresh = useSkillsStore((s) => s.refresh)
  const [name, setName] = useState(initial?.name ?? "")
  const [type, setType] = useState<"http" | "stdio">(initial?.type ?? "http")
  const [url, setUrl] = useState(initial?.url ?? "")
  const [command, setCommand] = useState(initial?.command ?? "")
  const [args, setArgs] = useState(initial?.args?.join(" ") ?? "")
  const [env, setEnv] = useState<Record<string, string>>(initial?.env ?? {})
  const [headers, setHeaders] = useState<Record<string, string>>(initial?.headers ?? {})
  const [cwd, setCwd] = useState(initial?.cwd ?? "")
  const [permissionMode, setPermissionMode] = useState<string>(initial?.permissionMode ?? "")
  const [autoReconnect, setAutoReconnect] = useState(initial?.autoReconnect ?? true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      setType(initial?.type ?? "http")
      setUrl(initial?.url ?? "")
      setCommand(initial?.command ?? "")
      setArgs(initial?.args?.join(" ") ?? "")
      setEnv(initial?.env ?? {})
      setHeaders(initial?.headers ?? {})
      setCwd(initial?.cwd ?? "")
      setPermissionMode(initial?.permissionMode ?? "")
      setAutoReconnect(initial?.autoReconnect ?? true)
    }
  }, [open, initial])

  const pickCwd = async () => {
    try {
      const result = await window.ipcRenderer.invoke("select-folder")
      if (result) setCwd(result as string)
    } catch {}
  }

  const save = async () => {
    if (!name.trim()) return
    setSaving(true)
    const config = await mcpApi.config()
    const entry: McpServerConfig = {
      name: name.trim(),
      type,
      ...(type === "http" ? { url: url.trim() } : { command: command.trim(), args: args.trim() ? args.trim().split(/\s+/) : [] }),
      enabled: true,
    }
    const envClean: Record<string, string> = {}
    for (const [k, v] of Object.entries(env)) {
      if (k.trim() && v) envClean[k.trim()] = v
    }
    if (Object.keys(envClean).length > 0) entry.env = envClean
    const headersClean: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      if (k.trim() && v) headersClean[k.trim()] = v
    }
    if (Object.keys(headersClean).length > 0) entry.headers = headersClean
    if (cwd.trim()) entry.cwd = cwd.trim()
    if (permissionMode) entry.permissionMode = permissionMode as "ask" | "approve" | "full"
    if (autoReconnect !== true) entry.autoReconnect = false

    const idx = config.servers.findIndex((s) => s.name === initial?.name)
    if (idx >= 0) {
      config.servers[idx] = entry
    } else {
      config.servers.push(entry)
    }
    await mcpApi.save(config)
    await refresh()
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{initial ? t("mcp.servers.dialog.editTitle") : t("mcp.servers.dialog.addTitle")}</DialogTitle>
          <DialogDescription>
            {t("mcp.servers.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.name")}</p>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mcp.servers.dialog.namePlaceholder")} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.type")}</p>
            <Select value={type} onValueChange={(v) => setType(v as "http" | "stdio")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">{t("mcp.servers.dialog.typeHttp")}</SelectItem>
                <SelectItem value="stdio">{t("mcp.servers.dialog.typeStdio")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {type === "http" ? (
            <>
              <div>
                <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.url")}</p>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.exa.ai/mcp" />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.headers")}</p>
                <KvEditor
                  value={headers}
                  onChange={setHeaders}
                  keyPlaceholder="Authorization"
                  valuePlaceholder="Bearer sk-..."
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.command")}</p>
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.args")}</p>
                <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder={t("mcp.servers.dialog.argsPlaceholder")} />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.cwd")}</p>
                <div className="flex items-center gap-2">
                  <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={t("mcp.servers.dialog.cwdPlaceholder")} className="flex-1" />
                  <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1" onClick={() => void pickCwd()}>
                    <Folder className="size-3" />
                    {t("mcp.servers.dialog.select")}
                  </Button>
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">{t("mcp.servers.dialog.env")}</p>
                <KvEditor
                  value={env}
                  onChange={setEnv}
                  keyPlaceholder="API_KEY"
                  valuePlaceholder="sk-..."
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {t("mcp.servers.dialog.envHint")}
                </p>
              </div>
            </>
          )}
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t("mcp.servers.dialog.advanced")}</p>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">{t("mcp.servers.dialog.permissionMode")}</p>
                <p className="text-[10px] text-muted-foreground">{t("mcp.servers.dialog.permissionModeHint")}</p>
              </div>
              <Select value={permissionMode} onValueChange={(value) => setPermissionMode(value ?? '')}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder={t("mcp.servers.dialog.permissionInherit")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">{t("mcp.servers.dialog.permissionInherit")}</SelectItem>
                  <SelectItem value="ask">{t("mcp.servers.dialog.permissionAsk")}</SelectItem>
                  <SelectItem value="approve">{t("mcp.servers.dialog.permissionApprove")}</SelectItem>
                  <SelectItem value="full">{t("mcp.servers.dialog.permissionFull")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">{t("mcp.servers.dialog.autoReconnect")}</p>
                <p className="text-[10px] text-muted-foreground">{t("mcp.servers.dialog.autoReconnectHint")}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoReconnect}
                onClick={() => setAutoReconnect(!autoReconnect)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
                  autoReconnect ? "bg-primary" : "bg-input"
                }`}
              >
                <span className={`inline-block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${autoReconnect ? "translate-x-4" : "translate-x-0"}`} />
              </button>
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            {saving && <LoaderCircle className="size-3.5 animate-spin" />}
            {initial ? t("common.save") : t("common.add")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/*  Dialog: Criar Skill Manualmente                                     */
/* ------------------------------------------------------------------ */

function sanitizeSlugHint(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60)
}

function CreateSkillDialog({ open, onOpenChange, initial }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: Skill
}) {
  const { t } = useTranslation()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState("")
  const [content, setContent] = useState("")
  const [saving, setSaving] = useState(false)
  const refresh = useSkillsStore((s) => s.refresh)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      setSlug(initial?.slug ?? "")
      setSlugEdited(!!initial)
      setSlugTouched(false)
      setDescription(initial?.description ?? "")
      setContent(initial?.content ?? "")
    }
  }, [open, initial])

  const slugError = useMemo(() => {
    if (!slugTouched || !slug) return ""
    if (!SLUG_REGEX.test(slug)) return t("mcp.skills.dialog.slugError")
    return ""
  }, [slug, slugTouched, t])

  const canSave = name.trim() && content.trim() && slug.trim() && !slugError

  const handleNameChange = (value: string) => {
    setName(value)
    if (!slugEdited) setSlug(sanitizeSlugHint(value))
  }

  const handleSlugChange = (value: string) => {
    setSlugEdited(true)
    setSlugTouched(true)
    setSlug(value.toLowerCase())
  }

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await skillsApi.create({
        name: name.trim(),
        description: description.trim(),
        content: content.trim(),
        slug: slug.trim(),
        oldSlug: initial?.slug !== slug.trim() ? initial?.slug : undefined,
      })
    } catch (err) {
      console.error("[skills] falha ao criar skill:", err)
    }
    await refresh()
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? t("mcp.skills.dialog.editTitle") : t("mcp.skills.dialog.createTitle")}</DialogTitle>
          <DialogDescription>
            {initial
              ? t("mcp.skills.dialog.editDescription")
              : t("mcp.skills.dialog.createDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium">{t("mcp.skills.dialog.name")}</p>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t("mcp.skills.dialog.namePlaceholder")}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">{t("mcp.skills.dialog.slug")}</p>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-muted-foreground">
                /
              </span>
              <Input
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder={t("mcp.skills.dialog.slugPlaceholder")}
                className={cn("pl-7", slugError && "border-destructive focus:border-destructive focus:ring-destructive/30")}
              />
            </div>
            {slugError && (
              <p className="mt-1 text-[11px] text-destructive">{slugError}</p>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">{t("mcp.skills.dialog.description")}</p>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("mcp.skills.dialog.descriptionPlaceholder")}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">{t("mcp.skills.dialog.content")}</p>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder={t("mcp.skills.dialog.contentPlaceholder")}
              className="min-h-[120px] w-full rounded-md border border-input bg-input/20 px-3 py-2 text-xs/relaxed outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common.cancel")}</Button>
          <Button disabled={!canSave || saving} onClick={() => void save()}>
            {saving && <LoaderCircle className="size-3.5 animate-spin" />}
            {initial ? t("common.save") : t("mcp.skills.dialog.createButton")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/*  Status badge                                                        */
/* ------------------------------------------------------------------ */

function StatusBadge({ state, error }: { state: string; error?: string }) {
  const { t } = useTranslation()
  const map: Record<string, { label: string; className: string }> = {
    connected: { label: t("mcp.servers.status.connected"), className: "text-emerald-500" },
    connecting: { label: t("mcp.servers.status.connecting"), className: "text-amber-500" },
    error: { label: error ?? t("mcp.servers.status.error"), className: "text-destructive" },
    disabled: { label: t("mcp.servers.status.disabled"), className: "text-muted-foreground" },
    unauthorized: { label: t("mcp.servers.status.unauthorized"), className: "text-amber-500" },
  }
  const s = map[state] ?? { label: state, className: "text-muted-foreground" }
  return <span className={cn("text-[10px] font-medium", s.className)}>{s.label}</span>
}

/* ------------------------------------------------------------------ */
/*  Integração oficial: Nodara                                          */
/* ------------------------------------------------------------------ */

const NODARA_SITE = "https://nodaraapp.com"
/** Enquanto o card está aberto, reflete o app Nodara abrindo/fechando. */
const NODARA_POLL_MS = 15_000

/** Cor do selo por estado: verde só quando as tools estão de fato no agente. */
const NODARA_BADGE_TONE: Record<NodaraStatus["state"], string> = {
  connected: "text-emerald-500",
  installed: "text-amber-500",
  error: "text-destructive",
  stopped: "text-muted-foreground",
  disabled: "text-muted-foreground",
  "not-installed": "text-muted-foreground",
}

/** Códigos que o main devolve normalizados (o 401 cru não ajuda ninguém). */
const NODARA_ERROR_KEYS: Record<string, string> = {
  "nodara-unauthorized": "mcp.integrations.nodaraError.unauthorized",
  "nodara-unreachable": "mcp.integrations.nodaraError.unreachable",
  "nodara-not-running": "mcp.integrations.nodaraError.notRunning",
  "nodara-not-found": "mcp.integrations.nodaraError.notFound",
  "nodara-no-token": "mcp.integrations.nodaraError.noToken",
}

/** Mensagem do estado atual — o card mostra sempre o que falta pra conectar. */
function nodaraHint(status: NodaraStatus, t: TFunction): string {
  if (status.state === "connected") {
    return t("mcp.integrations.nodaraTools", { count: status.toolCount })
  }
  if (status.tokenStale) return t("mcp.integrations.nodaraStaleToken")
  if (status.error) {
    const key = NODARA_ERROR_KEYS[status.error]
    return key ? t(key) : status.error
  }
  return t(`mcp.integrations.nodaraHint.${status.state}`)
}

function NodaraCard({ onChanged }: { onChanged: () => Promise<void> | void }) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<NodaraStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const next = await nodaraApi.discover().catch(() => null)
      if (alive && next) setStatus(next)
    }
    void load()
    const timer = setInterval(() => void load(), NODARA_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // Conectar cobre também o reparo: o main reescreve URL e token a partir do
  // ~/.nodara/mcp.json antes de reconectar, então um 401 por token vencido se
  // resolve no mesmo botão.
  const run = async (action: () => Promise<NodaraStatus>) => {
    setBusy(true)
    try {
      setStatus(await action())
      await onChanged()
    } finally {
      setBusy(false)
    }
  }

  const state = status?.state ?? "not-installed"
  const connected = state === "connected"
  const canConnect = state === "installed" || state === "error"
  // "stopped"/"disabled" dependem de uma ação do usuário dentro do Nodara —
  // o botão só re-checa o estado.
  const canRetry = state === "stopped" || state === "disabled"
  const actionLabel = canConnect
    ? t(state === "installed" ? "mcp.integrations.connect" : "mcp.integrations.reconnect")
    : canRetry
      ? t("mcp.integrations.retry")
      : t("mcp.integrations.download")

  return (
    <div className="flex items-center gap-3 rounded-lg border p-3">
      <img src={nodaraLogo} alt="" className="size-8 shrink-0 rounded-lg object-cover" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Nodara</span>
          {status && (
            <span className={cn("text-[10px] font-medium", NODARA_BADGE_TONE[state])}>
              {t(`mcp.integrations.state.${state}`)}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{t("mcp.integrations.nodaraDescription")}</p>
        {status && <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{nodaraHint(status, t)}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {connected && (
          <Button size="sm" variant="ghost" className="gap-1" disabled={busy} onClick={() => void run(nodaraApi.disconnect)}>
            {t("mcp.integrations.disconnect")}
          </Button>
        )}
        {!connected && (
          <Button
            size="sm"
            variant="outline"
            className="gap-1"
            disabled={busy}
            onClick={() => {
              if (canConnect) return void run(nodaraApi.connect)
              if (canRetry) return void run(nodaraApi.discover)
              window.open(NODARA_SITE, "_blank")
            }}
          >
            {busy ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : canConnect ? (
              <Cable className="size-3" />
            ) : canRetry ? (
              <RefreshCw className="size-3" />
            ) : (
              <ExternalLink className="size-3" />
            )}
            {actionLabel}
          </Button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Panel principal                                                     */
/* ------------------------------------------------------------------ */

export function McpSkillsPanel() {
  const { t } = useTranslation()
  const { skills, mcpServers, refresh } = useSkillsStore()
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [mcpEdit, setMcpEdit] = useState<McpServerConfig | undefined>()
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [skillEdit, setSkillEdit] = useState<Skill | undefined>()
  const [importError, setImportError] = useState("")
  const [viewContentSlug, setViewContent] = useState<string | null>(null)
  const viewSkill = viewContentSlug ? skills.find((s) => s.slug === viewContentSlug) ?? null : null

  const { setMode, setView } = useWorkspace()

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importSkill = async () => {
    setImportError("")
    const result = await skillsApi.import()
    if (result.error) setImportError(result.error)
    if (result.imported) await refresh()
  }

  // Abre um chat novo com "/create-skill " pré-preenchido
  const askOrbitToCreate = () => {
    useDraftInput.getState().setDraft("draft", "/create-skill ")
    setMode("chat")
    setView("chat")
    void useSessionStore.getState().selectSession("chat", null)
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      {/* Integrações oficiais */}
      <div>
        <div className="mb-2">
          <p className="text-sm font-semibold">{t("mcp.integrations.title")}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("mcp.integrations.description")}</p>
        </div>
        <NodaraCard onChanged={refresh} />
      </div>

      {/* Servidores MCP */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">{t("mcp.servers.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("mcp.servers.description")}
            </p>
          </div>
          <Button size="sm" className="gap-1" onClick={() => { setMcpEdit(undefined); setMcpDialogOpen(true) }}>
            <PlusIcon className="size-3.5" />
            {t("mcp.servers.add")}
          </Button>
        </div>
        {mcpServers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <Cable className="size-6 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">{t("mcp.servers.empty")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mcpServers.map((server) => {
              const active = server.state === "connected"
              return (
                <div key={server.config.name} className="flex items-start gap-3 rounded-lg border p-3">
                  <div className={cn("flex size-8 items-center justify-center rounded-full", active ? "bg-emerald-500/10" : "bg-muted")}>
                    <Server className={cn("size-4", active ? "text-emerald-500" : "text-muted-foreground/50")} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{server.config.name}</span>
                      <StatusBadge state={server.state} error={server.error} />
                    </div>
                    {active && server.toolNames.length > 0 && (
                      <details className="group mt-1">
                        <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground list-none flex items-center gap-1">
                          <ChevronDown className="size-3 shrink-0 transition-transform group-open:rotate-0 -rotate-90" />
                          {t("mcp.servers.toolsAvailable", { count: server.toolNames.length })}
                        </summary>
                        <div className="mt-1 flex flex-col gap-0.5">
                          {server.toolNames.map((name) => (
                            <div key={name} className="truncate rounded bg-muted/50 px-2 py-1 text-[10px] font-mono text-muted-foreground">
                              {name}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {server.state === "unauthorized" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1"
                        onClick={() => void mcpApi.auth(server.config.name).then(() => refresh())}
                      >
                        <KeyRound className="size-3" />
                        {t("mcp.servers.authorize")}
                      </Button>
                    )}
                    <Button size="icon-sm" variant="ghost" title={t("mcp.servers.reconnect")} onClick={() => void mcpApi.reconnect(server.config.name).then(() => refresh())}>
                      <RefreshCw className="size-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title={t("mcp.servers.edit")} onClick={() => { setMcpEdit(server.config); setMcpDialogOpen(true) }}>
                      <ExternalLink className="size-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title={t("mcp.servers.remove")} className="text-destructive hover:text-destructive" onClick={async () => {
                      const config = await mcpApi.config()
                      config.servers = config.servers.filter((s) => s.name !== server.config.name)
                      await mcpApi.save(config)
                      await refresh()
                    }}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Skills */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">{t("mcp.skills.title")}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("mcp.skills.description")}
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <PlusIcon className="size-3.5" />
              {t("mcp.skills.create")}
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64 p-1.5">
              <DropdownMenuItem onClick={() => { setSkillEdit(undefined); setSkillDialogOpen(true) }}>
                <PenLine className="size-3.5" />
                <div className="flex flex-col">
                  <span>{t("mcp.skills.createMenu.manual.title")}</span>
                  <span className="text-xs text-muted-foreground">{t("mcp.skills.createMenu.manual.description")}</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void importSkill()}>
                <FileUp className="size-3.5" />
                <div className="flex flex-col">
                  <span>{t("mcp.skills.createMenu.import.title")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("mcp.skills.createMenu.import.description")}
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={askOrbitToCreate}>
                <Wand2 className="size-3.5" />
                <div className="flex flex-col">
                  <span>{t("mcp.skills.createMenu.askOrbit.title")}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("mcp.skills.createMenu.askOrbit.description")}
                  </span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {importError && (
          <p className="mb-2 text-[11px] text-destructive">{importError}</p>
        )}
        {skills.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <Sparkles className="size-6 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">{t("mcp.skills.empty")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {skills.map((skill) => (
              <div key={skill.slug} className="flex items-start gap-3 rounded-lg border p-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                  <Sparkles className="size-4 text-muted-foreground/50" />
                </div>
                <div className="flex-1 min-w-0 overflow-hidden">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">@{skill.slug}</span>
                    <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      {skill.source}
                    </span>
                    {skill.scripts && skill.scripts.length > 0 && (
                      <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        {t("mcp.skills.scripts", { count: skill.scripts.length })}
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 text-[11px] text-muted-foreground line-clamp-2">{skill.description}</p>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="mt-1 h-auto p-0 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => setViewContent(skill.slug)}
                  >
                    <FileText className="mr-1 size-3" />
                    {t("mcp.skills.viewContent")}
                  </Button>
                </div>
                <div className="flex items-center gap-1 self-start pt-1">
                  <Button size="icon-sm" variant="ghost" title={t("mcp.skills.edit")} onClick={() => { setSkillEdit(skill); setSkillDialogOpen(true) }}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" title={t("mcp.skills.remove")} className="text-destructive hover:text-destructive" onClick={async () => {
                    await skillsApi.remove(skill.slug)
                    await refresh()
                  }}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <McpServerDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} initial={mcpEdit} />
      <CreateSkillDialog open={skillDialogOpen} onOpenChange={setSkillDialogOpen} initial={skillEdit} />
      <SkillContentDialog
        skill={viewSkill}
        open={viewContentSlug !== null}
        onOpenChange={(o) => { if (!o) setViewContent(null) }}
      />
    </div>
  )
}

// ─── Skill Content Dialog ──────────────────────────────────────────────────────

function SkillContentDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: Skill | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent style={{ maxWidth: "56rem" }}>
        <DialogHeader>
          <DialogTitle className="pr-6 text-sm font-medium">@{skill?.slug}</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            {skill?.name}{skill?.description ? ` — ${skill.description}` : ""}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] w-full overflow-x-auto pr-3">
          {skill?.content ? (
            <div className="w-full break-words">
              <AssistantMarkdown>{skill.content}</AssistantMarkdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("mcp.skills.noContent")}</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
