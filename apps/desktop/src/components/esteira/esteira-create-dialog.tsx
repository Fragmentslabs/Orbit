import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { GripVerticalIcon } from "lucide-react"
import type { FaseTemplate } from "@shared/esteira"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { FolderSelector } from "@/src/components/folder-selector"
import { useEsteiraStore } from "@/src/stores/esteira-store"
import { useProviderStore } from "@/src/stores/provider-store"
import { useBranchStore } from "@/src/stores/branch-store"
import { cn } from "@/lib/utils"

/**
 * Modal "Nova Esteira" (§3). Cria o projeto junto quando ainda não existe —
 * exigir dois passos separados para o primeiro uso só atrasaria o usuário.
 *
 * As fases escolhidas são COPIADAS dos templates pelo main (D4).
 */
export function EsteiraCreateDialog({
  aberto,
  onOpenChange,
  projetoId,
  onCriada,
}: {
  aberto: boolean
  onOpenChange: (aberto: boolean) => void
  /** Projeto existente; ausente = o projeto é criado junto com a esteira */
  projetoId?: string
  /** Abre a esteira recém-criada direto no board */
  onCriada?: (esteiraId: string) => void
}) {
  const { t } = useTranslation()
  const store = useEsteiraStore()
  const templates = useEsteiraStore((s) => s.templates)
  const catalog = useProviderStore((s) => s.catalog)

  const [nome, setNome] = useState("")
  const [pastas, setPastas] = useState<string[]>([])
  const [providerId, setProviderId] = useState("")
  const [modelId, setModelId] = useState("")
  const [selecionadas, setSelecionadas] = useState<string[]>([])
  const [branch, setBranch] = useState("")
  const [branches, setBranches] = useState<string[]>([])
  const [retryCount, setRetryCount] = useState(3)
  const [pushAoFinal, setPushAoFinal] = useState(false)
  const [salvando, setSalvando] = useState(false)

  const projetoExistente = useEsteiraStore((s) => s.projetos.find((p) => p.id === projetoId))

  // Estado inicial a cada abertura: fases padrão marcadas na ordem do template.
  useEffect(() => {
    if (!aberto) return
    setNome("")

    setPastas(projetoExistente?.pastas ?? [])
    setSelecionadas(templates.filter((tpl) => tpl.padrao).map((tpl) => tpl.id))
    setRetryCount(3)
    setPushAoFinal(false)
    setBranch("")
  }, [aberto, templates, projetoExistente])

  const provedores = useMemo(
    () => Object.values(catalog).filter((p) => Object.keys(p.models).length > 0),
    [catalog],
  )

  // Primeiro provedor/modelo disponível como padrão — o usuário troca se quiser.
  useEffect(() => {
    if (providerId || provedores.length === 0) return
    const primeiro = provedores[0]
    setProviderId(primeiro.id)
    setModelId(Object.keys(primeiro.models)[0] ?? "")
  }, [provedores, providerId])

  const modelos = providerId ? Object.values(catalog[providerId]?.models ?? {}) : []

  // Branches da pasta principal: a esteira trabalha num repo só.
  useEffect(() => {
    const raiz = pastas[0]
    if (!aberto || !raiz) {
      setBranches([])
      return
    }
    void useBranchStore
      .getState()
      .fetchBranches(raiz)
      .then(() => setBranches(useBranchStore.getState().byDir[raiz]?.branches ?? []))
  }, [aberto, pastas])

  const alternarFase = (id: string) => {
    setSelecionadas((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]))
  }

  const mover = (id: string, direcao: -1 | 1) => {
    setSelecionadas((atual) => {
      const indice = atual.indexOf(id)
      const destino = indice + direcao
      if (indice < 0 || destino < 0 || destino >= atual.length) return atual
      const proximo = [...atual]
      ;[proximo[indice], proximo[destino]] = [proximo[destino], proximo[indice]]
      return proximo
    })
  }

  // Pasta é obrigatória: sem repositório principal não há onde a esteira
  // trabalhar, e a task só falharia na primeira fase.
  const podeCriar = nome.trim().length > 0 && selecionadas.length > 0 && modelId.length > 0 && pastas.length > 0

  const criar = async () => {
    if (!podeCriar || salvando) return
    setSalvando(true)
    try {
      // O projeto (D1) é o dono das pastas. Como o fluxo do usuário é "criar
      // esteira e escolher o repositório", ele nasce junto, com o mesmo nome —
      // sem obrigar a cadastrar um projeto antes de fazer qualquer coisa.
      const alvo = projetoId ?? (await store.criarProjeto(nome.trim(), pastas)).id
      const esteira = await store.criarEsteira({
        projetoId: alvo,
        nome: nome.trim(),
        templateIds: selecionadas,
        providerId,
        modelId,
        branch: branch || undefined,
        retryCount,
        pushAoFinal,
      })
      onOpenChange(false)
      onCriada?.(esteira.id)
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Dialog open={aberto} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t("esteira.novaEsteira")}</DialogTitle>

        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <Campo rotulo={t("esteira.nomeEsteira")}>
            <Input value={nome} onChange={(e) => setNome(e.target.value)} className="h-8 text-sm" placeholder={t("esteira.nomeExemplo")} />
          </Campo>

          <Campo rotulo={t("esteira.pastas")} dica={t("esteira.pastasDica")}>
            <FolderSelector folders={pastas} onFoldersChange={setPastas} />
            {pastas.length > 0 && (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">
                {t("esteira.repositorioPrincipal")}: <span className="text-foreground">{pastas[0]}</span>
              </p>
            )}
          </Campo>

          <Campo rotulo={t("esteira.modeloPadrao")} dica={t("esteira.modeloDica")}>
            <div className="flex gap-2">
              <select
                value={providerId}
                onChange={(e) => {
                  setProviderId(e.target.value)
                  setModelId(Object.keys(catalog[e.target.value]?.models ?? {})[0] ?? "")
                }}
                className="h-8 flex-1 rounded-md border bg-background px-2 text-xs"
              >
                {provedores.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="h-8 flex-[2] rounded-md border bg-background px-2 text-xs"
              >
                {modelos.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </Campo>

          <Campo rotulo={t("esteira.fases")} dica={t("esteira.fasesDica")}>
            <div className="space-y-1">
              {templates.map((tpl) => (
                <FaseLinha
                  key={tpl.id}
                  template={tpl}
                  marcada={selecionadas.includes(tpl.id)}
                  posicao={selecionadas.indexOf(tpl.id)}
                  onAlternar={() => alternarFase(tpl.id)}
                  onMover={(d) => mover(tpl.id, d)}
                />
              ))}
            </div>
          </Campo>

          <Campo rotulo={t("esteira.branch")} dica={t("esteira.branchDica")}>
            <select
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              disabled={branches.length === 0}
            >
              <option value="">{t("esteira.branchAtual")}</option>
              {branches.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </Campo>

          <div className="flex gap-4">
            <Campo rotulo={t("esteira.retries")} dica={t("esteira.retriesDica")}>
              <Input
                type="number"
                min={1}
                max={10}
                value={retryCount}
                onChange={(e) => setRetryCount(Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                className="h-8 w-20 text-sm"
              />
            </Campo>
            <Campo rotulo={t("esteira.push")} dica={t("esteira.pushDica")}>
              <label className="flex h-8 items-center gap-2 text-xs">
                <input type="checkbox" checked={pushAoFinal} onChange={(e) => setPushAoFinal(e.target.checked)} />
                {t("esteira.pushAoFinal")}
              </label>
            </Campo>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={!podeCriar || salvando} onClick={() => void criar()}>
            {t("esteira.criar")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Campo({ rotulo, dica, children }: { rotulo: string; dica?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-foreground">{rotulo}</p>
      {dica && <p className="text-[11px] text-muted-foreground">{dica}</p>}
      {children}
    </div>
  )
}

function FaseLinha({
  template,
  marcada,
  posicao,
  onAlternar,
  onMover,
}: {
  template: FaseTemplate
  marcada: boolean
  posicao: number
  onAlternar: () => void
  onMover: (direcao: -1 | 1) => void
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors",
        marcada ? "border-primary/40 bg-primary/5" : "border-border",
      )}
    >
      <input type="checkbox" checked={marcada} onChange={onAlternar} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">
          {marcada && <span className="mr-1 text-muted-foreground">{posicao + 1}.</span>}
          {template.nome}
        </p>
        <p className="truncate text-[11px] text-muted-foreground">{template.descricao}</p>
      </div>
      {marcada && (
        <div className="flex shrink-0 flex-col">
          <button type="button" onClick={() => onMover(-1)} className="text-[9px] leading-none text-muted-foreground hover:text-foreground">▲</button>
          <button type="button" onClick={() => onMover(1)} className="text-[9px] leading-none text-muted-foreground hover:text-foreground">▼</button>
        </div>
      )}
      <GripVerticalIcon className="size-3 shrink-0 text-muted-foreground/40" />
    </div>
  )
}
