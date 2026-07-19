import { useEffect, useMemo, useRef, useState } from "react"
import {
  Cable,
  ChevronDown,
  ExternalLink,
  FileUp,
  FileText,
  Folder,
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
import { mcpApi, skillsApi } from "@/src/lib/ipc"
import { AssistantMarkdown } from "@/src/components/messages/shared"
import { useDraftInput } from "@/src/stores/draft-input"
import { useSessionStore } from "@/src/stores/session-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useSkillsStore } from "@/src/stores/skills-store"
import type { McpServerConfig } from "@shared/mcp"
import type { Skill } from "@shared/skills"

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
            placeholder={keyPlaceholder ?? "Chave"}
            className="h-7 w-[140px] text-xs"
          />
          <Input
            value={item.value}
            onChange={(e) => update(index, "value", e.target.value)}
            placeholder={valuePlaceholder ?? "Valor"}
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
        Adicionar
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
          <DialogTitle>{initial ? "Editar servidor MCP" : "Adicionar servidor MCP"}</DialogTitle>
          <DialogDescription>
            Conecte-se a servidores MCP (Model Context Protocol) para expandir as ferramentas do Orbit.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium">Nome</p>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ex: meu-servidor" />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Tipo</p>
            <Select value={type} onValueChange={(v) => setType(v as "http" | "stdio")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP (Streamable)</SelectItem>
                <SelectItem value="stdio">stdio (comando local)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {type === "http" ? (
            <>
              <div>
                <p className="mb-1 text-xs font-medium">URL</p>
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.exa.ai/mcp" />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">Headers (cabeçalhos HTTP)</p>
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
                <p className="mb-1 text-xs font-medium">Comando</p>
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">Argumentos (separados por espaço)</p>
                <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /caminho" />
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">Diretório de trabalho</p>
                <div className="flex items-center gap-2">
                  <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="Deixe vazio para herdar do Orbit" className="flex-1" />
                  <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1" onClick={() => void pickCwd()}>
                    <Folder className="size-3" />
                    Selecionar
                  </Button>
                </div>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium">Variáveis de ambiente</p>
                <KvEditor
                  value={env}
                  onChange={setEnv}
                  keyPlaceholder="API_KEY"
                  valuePlaceholder="sk-..."
                />
                <p className="mt-1 text-[10px] text-muted-foreground">
                  As variáveis são mescladas com o ambiente do Orbit; valores aqui sobrescrevem.
                </p>
              </div>
            </>
          )}
          <div className="border-t pt-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Opções avançadas</p>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">Modo de permissão</p>
                <p className="text-[10px] text-muted-foreground">Override do modo global para tools deste servidor</p>
              </div>
              <Select value={permissionMode} onValueChange={setPermissionMode}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Herda do chat" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Herda do chat</SelectItem>
                  <SelectItem value="ask">Perguntar</SelectItem>
                  <SelectItem value="approve">Autonomia</SelectItem>
                  <SelectItem value="full">Irrestrito</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div>
                <p className="text-xs font-medium">Reconexão automática</p>
                <p className="text-[10px] text-muted-foreground">Tenta reconectar com backoff exponencial em caso de erro</p>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!name.trim() || saving} onClick={() => void save()}>
            {saving && <LoaderCircle className="size-3.5 animate-spin" />}
            {initial ? "Salvar" : "Adicionar"}
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
    if (!SLUG_REGEX.test(slug)) return "Apenas letras minúsculas, números e underscores (_). Sem espaços ou acentos."
    return ""
  }, [slug, slugTouched])

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
          <DialogTitle>{initial ? "Editar skill" : "Criar skill"}</DialogTitle>
          <DialogDescription>
            {initial
              ? "Edite os campos da skill. O slug define a referência @slug na paleta \"/\"."
              : "Crie uma skill que será injetada no contexto do Orbit e referenciada via @slug na paleta \"/\"."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div>
            <p className="mb-1 text-xs font-medium">Nome</p>
            <Input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="Ex: Fazer Commit"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Slug (referência @slug)</p>
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-muted-foreground">
                /
              </span>
              <Input
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder="fazer_commit"
                className={cn("pl-7", slugError && "border-destructive focus:border-destructive focus:ring-destructive/30")}
              />
            </div>
            {slugError && (
              <p className="mt-1 text-[11px] text-destructive">{slugError}</p>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Descrição</p>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Padrões de commit e branch"
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium">Conteúdo (markdown)</p>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Use conventional commits: feat:, fix:, chore:..."
              className="min-h-[120px] w-full rounded-md border border-input bg-input/20 px-3 py-2 text-xs/relaxed outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button disabled={!canSave || saving} onClick={() => void save()}>
            {saving && <LoaderCircle className="size-3.5 animate-spin" />}
            {initial ? "Salvar" : "Criar skill"}
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
  const map: Record<string, { label: string; className: string }> = {
    connected: { label: "Conectado", className: "text-emerald-500" },
    connecting: { label: "Conectando…", className: "text-amber-500" },
    error: { label: error ?? "Erro", className: "text-destructive" },
    disabled: { label: "Desabilitado", className: "text-muted-foreground" },
  }
  const s = map[state] ?? { label: state, className: "text-muted-foreground" }
  return <span className={cn("text-[10px] font-medium", s.className)}>{s.label}</span>
}

/* ------------------------------------------------------------------ */
/*  Panel principal                                                     */
/* ------------------------------------------------------------------ */

export function McpSkillsPanel() {
  const { skills, mcpServers, refresh } = useSkillsStore()
  const [mcpDialogOpen, setMcpDialogOpen] = useState(false)
  const [mcpEdit, setMcpEdit] = useState<McpServerConfig | undefined>()
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [skillEdit, setSkillEdit] = useState<Skill | undefined>()
  const [importError, setImportError] = useState("")
  const [viewContentSlug, setViewContent] = useState<string | null>(null)
  const viewSkill = viewContentSlug ? skills.find((s) => s.slug === viewContentSlug) ?? null : null

  const { setMode, setView } = useWorkspace()
  const setSettingsOpen = useSettingsUi((s) => s.setOpen)

  useEffect(() => {
    void refresh()
  }, [refresh])

  const importSkill = async () => {
    setImportError("")
    const result = await skillsApi.import()
    if (result.error) setImportError(result.error)
    if (result.imported) await refresh()
  }

  // Fecha as settings e abre um chat novo com "/create-skill " pré-preenchido
  const askOrbitToCreate = () => {
    useDraftInput.getState().setDraft("/create-skill ")
    setSettingsOpen(false)
    setMode("chat")
    setView("chat")
    void useSessionStore.getState().selectSession("chat", null)
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      {/* Servidores MCP */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">Servidores MCP</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Conecte-se a servidores MCP para adicionar ferramentas dinâmicas ao Orbit.
            </p>
          </div>
          <Button size="sm" className="gap-1" onClick={() => { setMcpEdit(undefined); setMcpDialogOpen(true) }}>
            <PlusIcon className="size-3.5" />
            Adicionar
          </Button>
        </div>
        {mcpServers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-6 text-center">
            <Cable className="size-6 text-muted-foreground/50" />
            <p className="text-xs text-muted-foreground">Nenhum servidor MCP configurado.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {mcpServers.map((server) => {
              const active = server.state === "connected"
              return (
                <div key={server.config.name} className="flex items-center gap-3 rounded-lg border p-3">
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
                          {server.toolNames.length} ferramenta{(server.toolNames.length ?? 0) !== 1 ? "s" : ""} disponíve{(server.toolNames.length ?? 0) !== 1 ? "is" : "l"}
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
                    <Button size="icon-sm" variant="ghost" title="Reconectar" onClick={() => void mcpApi.reconnect(server.config.name).then(() => refresh())}>
                      <RefreshCw className="size-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title="Editar" onClick={() => { setMcpEdit(server.config); setMcpDialogOpen(true) }}>
                      <ExternalLink className="size-3.5" />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title="Remover" className="text-destructive hover:text-destructive" onClick={async () => {
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
            <p className="text-sm font-semibold">Skills</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Conhecimento curado injetado no contexto do agente. Crie ou gerencie suas skills.
            </p>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <PlusIcon className="size-3.5" />
              Criar
              <ChevronDown className="size-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64 p-1.5">
              <DropdownMenuItem onClick={() => { setSkillEdit(undefined); setSkillDialogOpen(true) }}>
                <PenLine className="size-3.5" />
                <div className="flex flex-col">
                  <span>Criar manualmente</span>
                  <span className="text-xs text-muted-foreground">Nome, descrição e conteúdo markdown</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void importSkill()}>
                <FileUp className="size-3.5" />
                <div className="flex flex-col">
                  <span>Importar arquivo</span>
                  <span className="text-xs text-muted-foreground">
                    .skill ou .md — selecione junto os scripts da skill, se houver
                  </span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={askOrbitToCreate}>
                <Wand2 className="size-3.5" />
                <div className="flex flex-col">
                  <span>Pedir para o Orbit criar</span>
                  <span className="text-xs text-muted-foreground">
                    Abre um chat com /create-skill — descreva e o agente monta a skill
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
            <p className="text-xs text-muted-foreground">Nenhuma skill criada ainda.</p>
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
                        {skill.scripts.length} script{skill.scripts.length > 1 ? "s" : ""}
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
                    Ver conteúdo
                  </Button>
                </div>
                <div className="flex items-center gap-1 self-start pt-1">
                  <Button size="icon-sm" variant="ghost" title="Editar" onClick={() => { setSkillEdit(skill); setSkillDialogOpen(true) }}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" title="Remover" className="text-destructive hover:text-destructive" onClick={async () => {
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
            <p className="text-sm text-muted-foreground">Nenhum conteúdo.</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
