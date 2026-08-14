import { useEffect, useRef } from "react"

/**
 * Abre o modal de configuração quando um modo que exige modelo configurado
 * (subagentes/orquestração → workerModel; visão → visionModel) está ATIVO POR
 * DEFAULT nas preferências e nunca foi configurado — o mesmo comportamento do
 * toggle e do dropdown "+", mas sem clique explícito.
 *
 * Regras:
 * - Pergunta UMA vez por chat (rascunho ou sessão); fechar o modal sem
 *   configurar marca como perguntado e não reabre para o mesmo chat.
 * - Rascunho → sessão adotada (primeiro envio) é o mesmo chat: o registro é
 *   transferido e o rascunho é limpo, então o PRÓXIMO chat novo volta a
 *   perguntar.
 * - Claim global por tipo de dialog: várias instâncias montadas (janela
 *   principal + painel lateral) nunca abrem dois dialogs ao mesmo tempo, e só
 *   o dono do claim o libera quando o dialog fecha.
 */

const DRAFT_KEY = "draft"

type PromptKind = "worker" | "vision"

/** Tipos de dialog já perguntados por chat (sessionId ?? "draft") */
const askedByChat = new Map<string, Set<PromptKind>>()
/** Dono do claim aberto por tipo de dialog — só o dono libera */
const claimOwners = new Map<PromptKind, symbol>()

export interface ModelConfigPromptOptions {
  sessionId?: string | null
  /** Estado efetivo (default das preferências já aplicado) dos modos que exigem configuração */
  subagents?: boolean
  orchestra?: boolean
  vision?: boolean
  /** Modelos globais configurados (provider-store) */
  workerConfigured?: boolean
  visionConfigured?: boolean
  /** Abrem os dialogs (funções locais do componente) */
  onOpenWorker?: () => void
  onOpenVision?: () => void
  /** Estado aberto dos dialogs — libera o claim quando fecham sem configurar */
  workerDialogOpen?: boolean
  visionDialogOpen?: boolean
}

export function useModelConfigPrompt(options: ModelConfigPromptOptions) {
  const {
    sessionId,
    subagents,
    orchestra,
    vision,
    workerConfigured,
    visionConfigured,
    workerDialogOpen,
    visionDialogOpen,
  } = options

  const instanceId = useRef(Symbol("model-config-prompt"))
  const actionsRef = useRef({ onOpenWorker: options.onOpenWorker, onOpenVision: options.onOpenVision })
  actionsRef.current = { onOpenWorker: options.onOpenWorker, onOpenVision: options.onOpenVision }

  // Rascunho → sessão adotada é o mesmo chat: transfere o registro de
  // perguntados e limpa o rascunho (o próximo chat novo volta a perguntar)
  const prevSessionRef = useRef(sessionId ?? null)
  useEffect(() => {
    const prev = prevSessionRef.current
    const curr = sessionId ?? null
    if (prev === null && curr !== null) {
      const draftAsked = askedByChat.get(DRAFT_KEY)
      if (draftAsked) {
        askedByChat.set(curr, new Set(draftAsked))
        askedByChat.delete(DRAFT_KEY)
      }
    }
    prevSessionRef.current = curr
  }, [sessionId])

  useEffect(() => {
    const chatKey = sessionId ?? DRAFT_KEY
    const asked = askedByChat.get(chatKey) ?? new Set<PromptKind>()
    const needsWorker = (subagents || orchestra) && !workerConfigured && !asked.has("worker")
    const needsVision = vision && !visionConfigured && !asked.has("vision")
    if (needsWorker && !claimOwners.has("worker") && actionsRef.current.onOpenWorker) {
      asked.add("worker")
      askedByChat.set(chatKey, asked)
      claimOwners.set("worker", instanceId.current)
      actionsRef.current.onOpenWorker()
    } else if (needsVision && !claimOwners.has("vision") && actionsRef.current.onOpenVision) {
      asked.add("vision")
      askedByChat.set(chatKey, asked)
      claimOwners.set("vision", instanceId.current)
      actionsRef.current.onOpenVision()
    }
    // workerDialogOpen/visionDialogOpen entram de propósito: fechar o dialog
    // reavalia o próximo modo pendente (ex.: subagentes → visão)
  }, [sessionId, subagents, orchestra, vision, workerConfigured, visionConfigured, workerDialogOpen, visionDialogOpen])

  // Libera o claim quando o dialog fecha (só o dono); o próximo modo pendente
  // ou um chat diferente pode abrir o dele. O cleanup cobre desmonte com o
  // dialog aberto (ex.: troca de viewMode), evitando claim órfão
  useEffect(() => {
    const owner = instanceId.current
    if (!workerDialogOpen && claimOwners.get("worker") === owner) claimOwners.delete("worker")
    return () => {
      if (claimOwners.get("worker") === owner) claimOwners.delete("worker")
    }
  }, [workerDialogOpen])
  useEffect(() => {
    const owner = instanceId.current
    if (!visionDialogOpen && claimOwners.get("vision") === owner) claimOwners.delete("vision")
    return () => {
      if (claimOwners.get("vision") === owner) claimOwners.delete("vision")
    }
  }, [visionDialogOpen])
}
