/**
 * A janela de uma faixa de áudio da peça — onde ela começa e onde ela termina.
 *
 * O manifest pode declarar `end`, e aí ele manda. Quando NÃO declara, os dois
 * lados que leem a faixa discordavam do que a ausência significa: o render
 * entende "o arquivo inteiro a partir do start" (em `motion-render-args`, sem
 * `end` não há `atrim`), enquanto a linha de tempo desenhava a barra até o FIM DA
 * PEÇA e mantinha a faixa acesa até lá — uma narração de 4 s aparecia
 * atravessando 20 s de vídeo.
 *
 * O comprimento real está no próprio elemento de áudio (`el.duration`, que o
 * navegador mede quando o metadata chega), então é ele que fecha a janela quando
 * o manifest se cala. As duas leituras — desenhar a barra e comandar o som —
 * saem daqui, de propósito: separadas, voltariam a discordar.
 */

export type MotionTrackWindow = {
  start: number
  /** Segundo em que a faixa sai; `null` quando o manifest não a delimitou. */
  end: number | null
}

/**
 * O segundo em que a faixa realmente termina, ou `null` quando não há como saber
 * (nem `end` no manifest, nem metadata carregado). Sem janela, quem chama decide
 * o que fazer — hoje, o palpite antigo: a peça inteira.
 */
export function motionTrackEnd(
  track: MotionTrackWindow,
  duration: number | null | undefined,
): number | null {
  if (track.end !== null) return track.end
  if (duration === null || duration === undefined) return null
  if (!Number.isFinite(duration) || duration <= 0) return null
  return track.start + duration
}

/** A faixa está dentro da janela dela naquele instante? */
export function motionTrackIsLive(
  track: MotionTrackWindow,
  duration: number | null | undefined,
  at: number,
): boolean {
  if (at < track.start) return false
  const end = motionTrackEnd(track, duration)
  return end === null || at < end
}

/** A partir daqui não é mais deriva, é reposicionamento (arrasto da régua, corte,
 *  troca de faixa). Aí o certo é seek — esperar o som alcançar seria ouvir errado. */
export const MOTION_AUDIO_SEEK_S = 0.4

/** Teto da correção de ritmo. 3% é inaudível numa fala. */
export const MOTION_AUDIO_MAX_NUDGE = 0.03

/** Deriva a partir da qual vale corrigir o ritmo. Tem de ser MAIOR que o passo do
 *  próprio laço: `at` vem do quadro (1/30 s ≈ 33 ms), então a deriva medida serra
 *  ±33 ms mesmo com o som parado no lugar certo. Uma folga de 20 ms caía DENTRO
 *  dessa serra — o ritmo piscava a cada quadro, e cada piscada reinicia o
 *  resample: é o estalo contínuo que se ouvia. */
export const MOTION_AUDIO_NUDGE_S = 0.15

/** Uma vez corrigindo, só para quando chega perto. É histerese: sem ela o ritmo
 *  fica ligando e desligando em cima do limiar. */
export const MOTION_AUDIO_SETTLE_S = 0.06

/**
 * Que RITMO pôr no elemento para ele alcançar o playhead sem cortar o som.
 *
 * Toda diferença de tempo era resolvida com `currentTime = …`. Enquanto o scheme
 * da composição não anunciava faixas, o Chromium IGNORAVA esse seek — e a escolha
 * era inofensiva. Quando ele passou a honrá-lo, cada deriva virou descarte de
 * buffer: o som picotava e nunca assentava, porque a cada reata o arquivo era
 * rebaixado de novo.
 *
 * Deriva pequena não precisa de seek: um ritmo de até 3% alcança o playhead em
 * poucos segundos, sem clique, sem silêncio e sem jogar fora o que já foi baixado.
 * `drift` é o quanto o elemento está À FRENTE do playhead (positivo = adiantado,
 * logo tem de desacelerar). `engaged` é o estado anterior do PRÓPRIO elemento —
 * ele já está corrigindo? — e é o que dá a histerese: sai por um limiar menor do
 * que entrou, então o ritmo não oscila em cima do limiar (que era o que fazia o
 * resample reiniciar sem parar).
 */
export function motionAudioRate(drift: number, engaged: boolean): number {
  if (!Number.isFinite(drift)) return 1
  if (Math.abs(drift) <= (engaged ? MOTION_AUDIO_SETTLE_S : MOTION_AUDIO_NUDGE_S)) return 1
  const nudge = Math.max(-MOTION_AUDIO_MAX_NUDGE, Math.min(MOTION_AUDIO_MAX_NUDGE, -drift * 0.5))
  return 1 + nudge
}
