import type { MachineTier } from '../machine'

/**
 * Perfis de gravação do `browser_record`.
 *
 * Um perfil junta as quatro decisões que andam juntas — fps, qualidade do x264,
 * qualidade do JPEG que o screencast emite e teto de resolução — em um nome que
 * o agente consegue escolher sem entender de codec.
 *
 * A regra de produto, que é o motivo deste módulo existir:
 *
 * - `auto` (padrão) SEGUE A MÁQUINA: forte grava a 60 fps em qualidade alta,
 *   fraca grava a 30 fps em qualidade baixa, para o take não engasgar;
 * - um nível EXPLÍCITO sempre vence o tier. Máquina fraca não impede ninguém de
 *   pedir `max` — o vídeo sai em `max`, no máximo com quadros repetidos. Quem
 *   avisa que faltou fôlego é o resultado (`capturedFps`), não um "não".
 *
 * Fica num módulo sem Electron de propósito: é a parte que mais muda e a que
 * mais vale ter teste.
 */

export type RecordQuality = 'auto' | 'low' | 'medium' | 'high' | 'max'

/** O perfil já resolvido — `auto` nunca chega aqui. */
export type FixedQuality = Exclude<RecordQuality, 'auto'>

export type RecordPreset = 'veryfast' | 'fast' | 'medium'

export interface RecordProfile {
  quality: FixedQuality
  /** Quadros por segundo do vídeo final. */
  fps: number
  /** CRF do x264: menor = melhor e maior. */
  crf: number
  /** Qualidade (1-100) do JPEG que o CDP emite por quadro. */
  jpegQuality: number
  /** Teto de largura do quadro capturado, em pixels de device. */
  maxWidth: number
  preset: RecordPreset
  /** O nível veio do pedido, não do tier da máquina. */
  explicit: boolean
}

const PROFILES: Record<FixedQuality, Omit<RecordProfile, 'quality' | 'explicit'>> = {
  low: { fps: 30, crf: 26, jpegQuality: 65, maxWidth: 1280, preset: 'veryfast' },
  medium: { fps: 30, crf: 22, jpegQuality: 75, maxWidth: 1600, preset: 'veryfast' },
  // 60 fps é o que faz um scroll e um hover parecerem "de verdade"; a partir
  // daqui o custo de encode sobe bastante, então só no high/max.
  high: { fps: 60, crf: 18, jpegQuality: 85, maxWidth: 1920, preset: 'fast' },
  max: { fps: 60, crf: 14, jpegQuality: 95, maxWidth: 2560, preset: 'medium' },
}

/** O que uma máquina forte ganha sozinha. */
const AUTO_BY_TIER: Record<MachineTier, FixedQuality> = {
  weak: 'low',
  balanced: 'medium',
  strong: 'high',
}

export interface RecordProfileInput {
  quality?: RecordQuality
  /** Override explícito do fps (vence o perfil). */
  fps?: number
  /** Override explícito do CRF (vence o perfil). */
  crf?: number
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function resolveRecordProfile(input: RecordProfileInput, tier: MachineTier): RecordProfile {
  const wanted = input.quality ?? 'auto'
  const explicit = wanted !== 'auto'
  const quality = explicit ? (wanted as FixedQuality) : AUTO_BY_TIER[tier]
  const base = PROFILES[quality]
  return {
    ...base,
    quality,
    explicit,
    fps: clamp(Math.round(input.fps ?? base.fps), 10, 60),
    crf: clamp(Math.round(input.crf ?? base.crf), 12, 34),
  }
}

/** Linha curta para o log/resultado: "high (auto · máquina forte) · 60 fps · crf 18". */
export function describeProfile(profile: RecordProfile, tier: MachineTier): string {
  const origin = profile.explicit ? 'pedido' : `auto · máquina ${tier}`
  return `${profile.quality} (${origin}) · ${profile.fps} fps · crf ${profile.crf}`
}
