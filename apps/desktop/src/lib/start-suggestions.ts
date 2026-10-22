import type { MediaKind } from "@shared/media"
import type { SessionMode } from "@shared/chat"

import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  type Capability,
  type CapabilityGroup,
  type CapabilityId,
} from "./capabilities"

/**
 * As três sugestões da tela inicial.
 *
 * A regra que importa: cada pill é sustentada por um fato que já está em
 * memória — uma sessão anterior, uma pasta de trabalho, o que a galeria diz
 * que a pessoa nunca produziu. Nada aqui consulta rede ou disco: é função
 * pura, testável, e a tela inicial continua instantânea.
 */

export type StartAction =
  /** Abre uma sessão existente. Navegação, não mensagem. */
  | { kind: "open"; sessionId: string; mode: SessionMode }
  /** Preenche o composer. Quem aperta Enter é a pessoa. */
  | { kind: "fill"; text: string }

export interface StartSuggestion {
  /** Estável no dia — é o que o React usa como key e o teste como assinatura. */
  id: string
  capability?: CapabilityId
  label: string
  action: StartAction
  /** Capacidade de uma família que a pessoa ainda não produziu. */
  fresh: boolean
}

export interface StartContext {
  mode: SessionMode
  /** Pasta principal de trabalho. No modo código, sem ela não há o que sugerir. */
  directory?: string
  /** Sessão recente do mesmo modo (e da mesma pasta, no código). */
  lastSession?: { id: string; title: string; mode: SessionMode }
  /** Tipos de mídia já produzidos alguma vez — vem da galeria. */
  usedKinds?: readonly MediaKind[]
  /**
   * Metades da voz ligadas nas Preferências. Desligada, a tool nem existe no
   * turno (`tools/index.ts`), então a pill seria uma promessa vazia: a
   * capacidade é pulada aqui e o painel oferece o botão de ativar.
   */
  features?: { tts: boolean; stt: boolean; browser: boolean }
  /** YYYY-MM-DD. Semente da rotação: igual durante o dia inteiro. */
  day: string
}

/** Tradutor já resolvido — o builder não conhece i18n, e assim dá para testar. */
export type Translate = (key: string, options?: Record<string, unknown>) => string

export const MAX_SUGGESTIONS = 3

export function buildStartSuggestions(ctx: StartContext, t: Translate): StartSuggestion[] {
  // Sem pasta o modo código não roda nada: o seletor de pasta vive no próprio
  // input, e uma pill aqui seria um botão que não leva a lugar nenhum.
  if (ctx.mode === "code" && !ctx.directory) return []

  const used = ctx.usedKinds ?? []
  const features = ctx.features ?? { tts: true, stt: true, browser: true }
  const seed = `${ctx.day}:${ctx.mode}`
  const suggestions: StartSuggestion[] = []

  if (ctx.lastSession) {
    suggestions.push({
      id: `resume:${ctx.lastSession.id}`,
      label: t("chat.start.resume", { title: ctx.lastSession.title }),
      action: { kind: "open", sessionId: ctx.lastSession.id, mode: ctx.lastSession.mode },
      fresh: false,
    })
  }

  for (const group of orderedGroups(seed, ctx.mode, used, features)) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    const capability = pickInGroup(group, ctx.mode, used, features, seed)
    if (!capability) continue
    suggestions.push({
      id: capability.id,
      capability: capability.id,
      label: t(`chat.start.items.${capability.id}.label`),
      action: { kind: "fill", text: t(`chat.start.items.${capability.id}.example`) },
      fresh: isFresh(capability, used),
    })
  }

  return suggestions
}

/**
 * Grupos com novidade primeiro, depois a ordem girada do dia. Assim quem nunca
 * gerou vídeo vê vídeo antes de mais um documento, mesmo que a rotação do dia
 * começasse por "create".
 */
function orderedGroups(
  seed: string,
  mode: SessionMode,
  used: readonly MediaKind[],
  features: { tts: boolean; stt: boolean; browser: boolean },
): CapabilityGroup[] {
  const shift = hash(seed) % CAPABILITY_GROUPS.length
  const rotated = [...CAPABILITY_GROUPS.slice(shift), ...CAPABILITY_GROUPS.slice(0, shift)]
  const withFresh = rotated.filter((group) =>
    CAPABILITIES.some(
      (capability) =>
        capability.group === group &&
        capability.modes.includes(mode) &&
        capability.hasExample &&
        isAvailable(capability, features) &&
        isFresh(capability, used),
    ),
  )
  return [...withFresh, ...rotated.filter((group) => !withFresh.includes(group))]
}

function pickInGroup(
  group: CapabilityGroup,
  mode: SessionMode,
  used: readonly MediaKind[],
  features: { tts: boolean; stt: boolean; browser: boolean },
  seed: string,
): Capability | undefined {
  const pool = CAPABILITIES.filter(
    (capability) =>
      capability.group === group &&
      capability.modes.includes(mode) &&
      capability.hasExample &&
      isAvailable(capability, features),
  )
  if (pool.length === 0) return undefined
  const fresh = pool.filter((capability) => isFresh(capability, used))
  const candidates = fresh.length > 0 ? fresh : pool
  return candidates[hash(`${seed}:${group}`) % candidates.length]
}

/** Recurso desligado = tool ausente no turno. Não entra nem como novidade. */
function isAvailable(
  capability: Capability,
  features: { tts: boolean; stt: boolean; browser: boolean },
): boolean {
  if (capability.requires === "tts") return features.tts
  if (capability.requires === "stt") return features.stt
  if (capability.requires === "browser") return features.browser
  return true
}

function isFresh(capability: Capability, used: readonly MediaKind[]): boolean {
  return capability.produces !== undefined && !used.includes(capability.produces)
}

/** FNV-1a: determinístico entre processos, ao contrário de Math.random(). */
function hash(input: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value >>> 0
}
