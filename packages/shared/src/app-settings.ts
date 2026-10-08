import type { ReasoningConfig } from './chat'

/**
 * Configurações gerais do app (Preferências → Geral e Navegador).
 *
 * O renderer é a fonte da verdade (vivem no localStorage dele) e empurra uma
 * cópia ao main a cada mudança; o main grava essa cópia em disco porque parte
 * delas vale antes de qualquer janela abrir (cookies do navegador, arquivamento
 * automático). Os valores padrão reproduzem o comportamento de antes de cada
 * opção existir.
 */

/** Como a resposta do agente é exibida no chat. */
export type ChatViewMode =
  /** Raciocínio reunido num bloco só no topo; ações agrupadas e recolhidas. */
  | 'summary'
  /** Cada passo no lugar em que aconteceu: raciocínio e ações em acordeons. */
  | 'steps'
  /** Tudo aberto, sem acordeons: raciocínio por extenso e cada ação listada. */
  | 'detailed'

/**
 * Quando compactar o histórico sozinho. `auto` = perto do limite do modelo.
 * Não há "desligada": sem compactar, a conversa acaba estourando o contexto
 * do modelo e para de responder.
 */
export type AutoCompactMode = 'auto' | '75' | '50'

/** Onde abrir links clicados no app. */
export type LinkTarget = 'integrated' | 'external'

/** Por quanto tempo o navegador integrado guarda cookies e logins. */
export type CookieRetention = 'persistent' | 'until-quit'

export interface AppSettings {
  /** Modelo para tarefas auxiliares (título, compactação, sugestões). null = o modelo da conversa. */
  auxModel: { providerId: string; modelId: string } | null
  /** Raciocínio do modelo auxiliar. null = sem raciocínio. */
  auxReasoning: ReasoningConfig | null
  /** Sugere a próxima mensagem no input (Tab completa). */
  promptSuggestions: boolean
  chatView: ChatViewMode
  /** Arquiva conversas sem atividade há N dias. null = desligado. */
  autoArchiveDays: number | null
  /** Exclui conversas arquivadas há N dias (contados desde o arquivamento). null = desligado. */
  deleteArchivedDays: number | null
  autoCompact: AutoCompactMode
  /** Rodadas extras em falha temporária (mensagens da fila). 0 = desligado. */
  transientRetries: number
  /** Continuações automáticas quando a resposta para no limite de passos. 0 = desligado. */
  autoContinues: number
  /** Largura da sidebar esquerda, em px (arrastável pela borda). */
  sidebarWidth: number
  browser: {
    links: LinkTarget
    /** O agente usa o navegador por conta própria (testar, capturar, documentar). */
    agentTools: boolean
    cookies: CookieRetention
  }
}

/** Largura da sidebar: 256px é o tamanho histórico (16rem), e o teto evita que
 *  ela coma o conteúdo em janela estreita. */
export const SIDEBAR_DEFAULT_WIDTH = 256
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 420

/** Traz a largura para dentro do arrastável (usado ao normalizar e ao arrastar). */
export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  auxModel: null,
  auxReasoning: null,
  promptSuggestions: false,
  chatView: 'summary',
  autoArchiveDays: null,
  deleteArchivedDays: null,
  autoCompact: 'auto',
  transientRetries: 3,
  autoContinues: 3,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  browser: {
    links: 'integrated',
    agentTools: true,
    cookies: 'persistent',
  },
}

export const AUTO_ARCHIVE_DAY_OPTIONS = [2, 3, 7, 14, 30, 90] as const
export const DELETE_ARCHIVED_DAY_OPTIONS = [7, 14, 30, 90] as const
export const MAX_TRANSIENT_RETRIES = 5
export const MAX_AUTO_CONTINUES = 5

/**
 * Completa um objeto parcial (versão antiga salva, ou o que veio de outro
 * processo) com os padrões, descartando valores fora do domínio. Nunca lança.
 */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<AppSettings>
  const d = DEFAULT_APP_SETTINGS
  const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
    options.includes(v as T) ? (v as T) : fallback
  const count = (v: unknown, max: number, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : fallback
  const model = (v: unknown) =>
    v && typeof v === 'object' && typeof (v as { providerId?: unknown }).providerId === 'string' &&
    typeof (v as { modelId?: unknown }).modelId === 'string'
      ? { providerId: (v as { providerId: string }).providerId, modelId: (v as { modelId: string }).modelId }
      : null
  const reasoning = (v: unknown): ReasoningConfig | null =>
    v && typeof v === 'object' && typeof (v as { enabled?: unknown }).enabled === 'boolean'
      ? {
          enabled: (v as ReasoningConfig).enabled,
          variantId: typeof (v as ReasoningConfig).variantId === 'string' ? (v as ReasoningConfig).variantId : undefined,
        }
      : null
  const dayOption = (v: unknown, options: readonly number[]) =>
    typeof v === 'number' && options.includes(v) ? v : null
  const browser = (value.browser && typeof value.browser === 'object' ? value.browser : {}) as Partial<AppSettings['browser']>
  const sidebarWidth =
    typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
      ? clampSidebarWidth(value.sidebarWidth)
      : d.sidebarWidth
  return {
    auxModel: model(value.auxModel),
    auxReasoning: reasoning(value.auxReasoning),
    promptSuggestions: typeof value.promptSuggestions === 'boolean' ? value.promptSuggestions : d.promptSuggestions,
    chatView: oneOf(value.chatView, ['summary', 'steps', 'detailed'], d.chatView),
    autoArchiveDays: dayOption(value.autoArchiveDays, AUTO_ARCHIVE_DAY_OPTIONS),
    deleteArchivedDays: dayOption(value.deleteArchivedDays, DELETE_ARCHIVED_DAY_OPTIONS),
    // 'off' de versões anteriores cai no padrão: a opção deixou de existir.
    autoCompact: oneOf(value.autoCompact, ['auto', '75', '50'], d.autoCompact),
    transientRetries: count(value.transientRetries, MAX_TRANSIENT_RETRIES, d.transientRetries),
    autoContinues: count(value.autoContinues, MAX_AUTO_CONTINUES, d.autoContinues),
    sidebarWidth,
    browser: {
      links: oneOf(browser.links, ['integrated', 'external'], d.browser.links),
      agentTools: typeof browser.agentTools === 'boolean' ? browser.agentTools : d.browser.agentTools,
      cookies: oneOf(browser.cookies, ['persistent', 'until-quit'], d.browser.cookies),
    },
  }
}
