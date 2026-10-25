/**
 * Overlay do Orbit: a janela que desce no rodapé da tela pelo atalho global
 * (⇧⌘espaço) para perguntar, traduzir o que está selecionado ou conversar por
 * voz sem sair do que a pessoa está fazendo.
 *
 * Aqui vive só o contrato (preferências + o contexto que o main entrega ao
 * renderer ao abrir). O comportamento mora em electron/lib/overlay e em
 * src/components/overlay.
 */

/** Como o overlay abre: com o campo de texto ou direto em modo chamada. */
export type OverlayOpenMode = "text" | "call"

export interface OverlaySettings {
  /** Atalho global ligado. Desligado, o overlay só abre pelo menu/Preferências. */
  enabled: boolean
  /** Abre já em modo chamada (exige TTS e ditado ligados em Preferências → Voz). */
  openInCall: boolean
  /**
   * Modelo deste modo. `null` = o modelo selecionado na conversa (o mesmo
   * default global do app).
   */
  model: { providerId: string; modelId: string } | null
  /**
   * Modo Visão: a tela capturada vai para o modelo de visão (o mesmo das
   * Preferências de visão, global), que devolve uma descrição em texto. É o
   * caminho padrão porque funciona com qualquer modelo principal — e é o único
   * que enxerga quando o modelo do painel é só de texto.
   *
   * Desligado, a imagem vai direto ao modelo do painel, e só se ele tiver
   * visão; sem nenhum dos dois, o agente diz que não consegue olhar a tela.
   */
  vision: boolean
  /** Opacidade do fundo do painel (1 = sólido). O texto nunca fica translúcido. */
  opacity: number
  /** A persona (Rive) no lugar da marca. Sem ela, o painel mostra o halo estático. */
  persona: boolean
}

/**
 * Atalho padrão. Cmd+Space é o Spotlight do macOS; Shift+Cmd+Space está livre
 * e é o que a maioria dos assistentes sobrepostos usa.
 */
export const OVERLAY_SHORTCUT = "CommandOrControl+Shift+Space"

export const OVERLAY_SHORTCUT_LABEL: Record<string, string> = {
  darwin: "⇧⌘espaço",
  win32: "Ctrl+Shift+Space",
  linux: "Ctrl+Shift+Space",
}

/** Piso da opacidade: abaixo disso o painel some sobre um papel de parede claro. */
export const OVERLAY_OPACITY_MIN = 0.5

export const OVERLAY_DEFAULTS: OverlaySettings = {
  enabled: true,
  // Abre falando: é para isso que o atalho existe — perguntar de passagem, sem
  // parar o que se está fazendo. Sem fala e ditado ligados (ou com o modelo de
  // voz ausente) o painel cai no campo de texto, com o aviso do motivo.
  openInCall: true,
  model: null,
  // Olhar a tela é o que o atalho mais serve para fazer, e o modo Visão é o
  // único caminho que funciona com qualquer modelo principal — inclusive um só
  // de texto. Sem modelo de visão escolhido, a tela continua ilegível para o
  // agente, e ele é instruído a dizer isso em vez de adivinhar.
  vision: true,
  opacity: 0.94,
  persona: true,
}

/** Completa um bloco parcial/antigo, descartando valores fora do domínio. */
export function normalizeOverlaySettings(raw: unknown): OverlaySettings {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<OverlaySettings>
  const model =
    value.model &&
    typeof value.model === "object" &&
    typeof (value.model as { providerId?: unknown }).providerId === "string" &&
    typeof (value.model as { modelId?: unknown }).modelId === "string"
      ? {
          providerId: (value.model as { providerId: string }).providerId,
          modelId: (value.model as { modelId: string }).modelId,
        }
      : null
  const opacity =
    typeof value.opacity === "number" && Number.isFinite(value.opacity)
      ? Math.min(1, Math.max(OVERLAY_OPACITY_MIN, value.opacity))
      : OVERLAY_DEFAULTS.opacity
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : OVERLAY_DEFAULTS.enabled,
    openInCall: typeof value.openInCall === "boolean" ? value.openInCall : OVERLAY_DEFAULTS.openInCall,
    model,
    vision: typeof value.vision === "boolean" ? value.vision : OVERLAY_DEFAULTS.vision,
    opacity,
    persona: typeof value.persona === "boolean" ? value.persona : OVERLAY_DEFAULTS.persona,
  }
}

/**
 * O que o main entrega ao renderer quando o overlay abre. A seleção é lida
 * ANTES de a janela receber o foco — depois disso o app em primeiro plano já é
 * o Orbit, e não há mais seleção alheia para ler.
 */
export interface OverlayContext {
  /** Abriu em modo chamada? */
  call: boolean
  /** Texto selecionado no app que estava na frente (null = nada selecionado). */
  selection: string | null
  /** App de onde a seleção veio, para mostrar de onde o texto saiu. */
  selectionApp: string | null
  settings: OverlaySettings
  at: number
}

/** Eventos do main para o overlay. */
export type OverlayEvent =
  /** O agente encerrou a conversa ("tchau, Orbit") — a UI desliga a chamada. */
  | { type: "hangup"; reason?: string }
  /** Preferências mudaram com o overlay aberto (opacidade, persona, modelo). */
  | { type: "settings"; settings: OverlaySettings }
  /** A seleção lida depois da abertura (o painel não espera o `osascript`). */
  | { type: "selection"; text: string | null; app: string | null }
