import { useEffect, useMemo, useState } from "react"
import {
  Cable,
  ChevronDown,
  ExternalLink,
  FileUp,
  LoaderCircle,
  Pencil,
  PenLine,
  PlusIcon,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { useDraftInput } from "@/src/stores/draft-input"
import { useSessionStore } from "@/src/stores/session-store"
import { useSettingsUi } from "@/src/stores/settings-ui"
import { useSkillsStore } from "@/src/stores/skills-store"
import type { McpServerConfig } from "@shared/mcp"
import type { Skill } from "@shared/skills"

/** Regex de slug válido: apenas minúsculas, números e underscores */
const SLUG_REGEX = /^[a-z0-9_]+$/

/* ------------------------------------------------------------------ */
/*  Dialog: Adicionar / Editar Servidor MCP                            */
/* ------------------------------------------------------------------ */

function McpServerDialog({ open, onOpenChange, initial }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: McpServerConfig
}) {
  const [name, setName] = useState(initial?.name ?? "")
  const [type, setType] = useState<"http" | "stdio">(initial?.type ?? "http")
  const [url, setUrl] = useState(initial?.url ?? "")
  const [command, setCommand] = useState(initial?.command ?? "")
  const [args, setArgs] = useState(initial?.args?.join(" ") ?? "")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initial?.name ?? "")
      setType(initial?.type ?? "http")
      setUrl(initial?.url ?? "")
      setCommand(initial?.command ?? "")
      setArgs(initial?.args?.join(" ") ?? "")
    }
  }, [open, initial])

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
    const idx = config.servers.findIndex((s) => s.name === initial?.name)
    if (idx >= 0) {
      config.servers[idx] = entry
    } else {
      config.servers.push(entry)
    }
    await mcpApi.save(config)
    setSaving(false)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
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
            <div>
              <p className="mb-1 text-xs font-medium">URL</p>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.exa.ai/mcp" />
            </div>
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
            </>
          )}
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
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                      {server.config.type === "http" ? server.config.url : `${server.config.command} ${(server.config.args ?? []).join(" ")}`}
                    </p>
                    {active && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        {server.toolNames.length} ferramenta{(server.toolNames.length ?? 0) !== 1 ? "s" : ""} disponíve{(server.toolNames.length ?? 0) !== 1 ? "is" : "l"}: {server.toolNames.join(", ")}
                      </p>
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
                <div className="flex-1 min-w-0">
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
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{skill.description}</p>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">
                      Ver conteúdo
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-muted p-2 text-[10px] text-muted-foreground">
                      {skill.content}
                    </pre>
                  </details>
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
    </div>
  )
}
