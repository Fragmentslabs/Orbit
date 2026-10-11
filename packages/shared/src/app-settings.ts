import type { ReasoningConfig } from './chat'
import { VOICE_DEFAULTS, type VoiceEngineId, type VoiceSettings, type VoiceTtsEngine } from './voice'

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

/**
 * Onde os worktrees criados pelo Orbit (chats e tasks da esteira) ficam.
 *  - `padrao`: na pasta de dados do Orbit, fora de qualquer projeto;
 *  - `projeto`: dentro do repositório, em .orbit/worktrees (o Orbit tira a
 *    pasta do git pelo .git/info/exclude) — visível no editor;
 *  - `personalizada`: numa pasta escolhida pelo usuário.
 * Vale para worktrees novos: os existentes continuam onde estão.
 */
export type LocalWorktrees = 'padrao' | 'projeto' | 'personalizada'

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
  worktrees: {
    local: LocalWorktrees
    /** Só com local = 'personalizada' */
    pasta: string | null
  }
  /** Núcleo de voz (TTS local e ditado/STT). Ver voice.ts. */
  voice: VoiceSettings
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
  worktrees: {
    local: 'padrao',
    pasta: null,
  },
  // Cópia própria dos padrões: o objeto do voice.ts é constante compartilhada e
  // não pode virar o alvo de uma edição acidental da UI.
  voice: { tts: { ...VOICE_DEFAULTS.tts }, stt: { ...VOICE_DEFAULTS.stt } },
}

export const AUTO_ARCHIVE_DAY_OPTIONS = [2, 3, 7, 14, 30, 90] as const
export const DELETE_ARCHIVED_DAY_OPTIONS = [7, 14, 30, 90] as const
export const MAX_TRANSIENT_RETRIES = 5
export const MAX_AUTO_CONTINUES = 5

/** Ids de voz do Supertonic 3: M1–M5 (masculinas) e F1–F5 (femininas). */
const VOICE_ID = /^[MF][1-5]$/
/** Código de idioma curto (`pt`, `en`, `na`); o STT também aceita `auto`. */
const VOICE_LANG = /^[a-z]{2,8}$/

/**
 * Normaliza o bloco de voz. Os campos do Supertonic seguem o contrato do motor
 * (voz no formato M#/F#, `speed` entre 0,5 e 2 limitado lá também), então um
 * valor salvo fora do domínio vira o padrão em vez de derrubar a síntese.
 */
function voiceSettings(raw: unknown, d: VoiceSettings): VoiceSettings {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<VoiceSettings>
  const tts = (v.tts && typeof v.tts === 'object' ? v.tts : {}) as Partial<VoiceSettings['tts']>
  const stt = (v.stt && typeof v.stt === 'object' ? v.stt : {}) as Partial<VoiceSettings['stt']>
  const voz = typeof tts.voice === 'string' ? tts.voice.trim().toUpperCase() : ''
  const lang = typeof tts.lang === 'string' ? tts.lang.trim().toLowerCase() : ''
  const speed = typeof tts.speed === 'number' && Number.isFinite(tts.speed)
    ? Math.min(2, Math.max(0.5, tts.speed))
    : d.tts.speed
  const language = typeof stt.language === 'string' ? stt.language.trim().toLowerCase() : ''
  const threads = typeof stt.threads === 'number' && Number.isInteger(stt.threads) && stt.threads >= 1 && stt.threads <= 16
    ? stt.threads
    : d.stt.threads
  return {
    tts: {
      enabled: typeof tts.enabled === 'boolean' ? tts.enabled : d.tts.enabled,
      voice: VOICE_ID.test(voz) ? voz : d.tts.voice,
      lang: VOICE_LANG.test(lang) ? lang : d.tts.lang,
      speed,
      // Prioridade de áudio: valor fora do domínio volta ao padrão ("model").
      engine: oneOfVoiceTtsEngine(tts.engine, d.tts.engine),
    },
    stt: {
      enabled: typeof stt.enabled === 'boolean' ? stt.enabled : d.stt.enabled,
      engine: oneOfVoiceEngine(stt.engine, d.stt.engine),
      modelId: typeof stt.modelId === 'string' && stt.modelId.trim() ? stt.modelId.trim() : null,
      language: VOICE_LANG.test(language) ? language : d.stt.language,
      live: typeof stt.live === 'boolean' ? stt.live : d.stt.live,
      preload: typeof stt.preload === 'boolean' ? stt.preload : d.stt.preload,
      threads,
    },
  }
}

function oneOfVoiceEngine(value: unknown, fallback: VoiceEngineId): VoiceEngineId {
  return value === 'parakeet' || value === 'whisper' ? value : fallback
}

/** Prioridade de áudio do TTS: `model` (rota pelo modelo) ou `local`. */
function oneOfVoiceTtsEngine(value: unknown, fallback: VoiceTtsEngine): VoiceTtsEngine {
  return value === 'model' || value === 'local' ? value : fallback
}

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
    worktrees: (() => {
      const w = (value.worktrees && typeof value.worktrees === 'object' ? value.worktrees : {}) as Partial<AppSettings['worktrees']>
      const pasta = typeof w.pasta === 'string' && w.pasta.trim() ? w.pasta.trim() : null
      const local = oneOf(w.local, ['padrao', 'projeto', 'personalizada'], d.worktrees.local)
      // Personalizada sem pasta escolhida não tem para onde ir: volta ao padrão.
      return local === 'personalizada' && !pasta ? { local: d.worktrees.local, pasta: null } : { local, pasta }
    })(),
    voice: voiceSettings(value.voice, d.voice),
  }
}
