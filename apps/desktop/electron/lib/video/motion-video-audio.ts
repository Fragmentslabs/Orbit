import path from 'node:path'
import type { MotionAudioTrack } from './motion-audio'
import { NO_FX } from './motion-audio-fx'

/**
 * O SOM dos `<video>` de uma composição.
 *
 * O runtime silencia todo vídeo da página (a janela do render não tem som e o
 * seek posiciona o arquivo quadro a quadro), então o som que o autor espera
 * ouvir — a fala de um depoimento, o ambiente de um b-roll — se perdia no
 * caminho. Aqui ele volta pela porta que já existe: vira uma FAIXA do plano de
 * áudio, exatamente como uma declarada no `audio.json`. O render a mistura, a
 * aba a toca numa linha própria, e o lint a confere — nada de caminho paralelo.
 *
 * O que decide se um vídeo soa: o arquivo ter uma faixa de áudio, e o autor não
 * o ter calado (atributo `muted`, ou `data-audio="false"`). O tempo vem dos
 * mesmos atributos que o runtime usa para posicionar a imagem (`data-start`,
 * `data-in`, `data-end`, `loop`), então som e imagem não podem discordar.
 */

/** O retrato de um `<video>` que o runtime publica (ver `videoFacts`). */
export interface MotionVideoFact {
  src: string
  muted: boolean
  loop: boolean
  /** dB. */
  gain: number
  start: number
  in: number
  end?: number
}

/**
 * Caminho do arquivo dentro da pasta a partir do `src` que o runtime leu: a URL
 * do scheme (`orbit-motion://<id>/clip.mp4`) ou um caminho relativo. Fora da
 * pasta, ou URL de outro lugar, é `null` — o scheme não serve nada de lá e o
 * lint já avisa do arquivo.
 */
export function videoFileIn(folder: string, src: string): string | null {
  let rel: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src)) {
    let url: URL
    try {
      url = new URL(src)
    } catch {
      return null
    }
    if (url.protocol !== 'orbit-motion:') return null
    rel = url.pathname
  } else {
    rel = src.split(/[?#]/)[0]
  }
  try {
    rel = decodeURIComponent(rel)
  } catch {
    return null
  }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel) return null
  const root = path.resolve(folder)
  const file = path.resolve(root, rel)
  const inside = path.relative(root, file)
  return inside.startsWith('..') || path.isAbsolute(inside) ? null : file
}

/** O arquivo tem faixa de áudio? Injetável: o padrão pergunta ao ffprobe. */
export type HasAudio = (file: string) => Promise<boolean>

async function probeHasAudio(file: string): Promise<boolean> {
  // Import tardio: o ffmpeg do app puxa o Electron, e este módulo precisa ser
  // testável sem ele.
  const { probeMedia } = await import('./ffmpeg')
  return (await probeMedia(file)).audio.length > 0
}

/**
 * As faixas de áudio dos vídeos da página. Vídeo calado, fora da pasta, sem faixa
 * de áudio ou ilegível não gera nada — e nunca derruba quem chama. O mesmo arquivo
 * com o mesmo recorte, usado por dois elementos, soa uma vez só.
 */
export async function motionVideoAudioTracks(
  folder: string,
  facts: MotionVideoFact[] | undefined,
  hasAudio: HasAudio = probeHasAudio,
): Promise<MotionAudioTrack[]> {
  const root = path.resolve(folder)
  const seen = new Set<string>()
  const tracks: MotionAudioTrack[] = []
  for (const fact of facts ?? []) {
    if (fact.muted) continue
    const file = videoFileIn(root, fact.src)
    if (!file) continue
    const key = [file, fact.start, fact.in, fact.end, fact.loop].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    if (!(await hasAudio(file).catch(() => false))) continue
    const end = typeof fact.end === 'number' && fact.end > fact.start ? fact.end : undefined
    tracks.push({
      file,
      name: `${path.basename(file)} (video)`,
      path: path
        .relative(root, file)
        .split(path.sep)
        .map((segment) => encodeURIComponent(segment))
        .join('/'),
      start: Math.max(0, fact.start),
      ...(end !== undefined ? { end } : {}),
      gainDb: Number.isFinite(fact.gain) ? fact.gain : 0,
      fadeIn: 0,
      fadeOut: 0,
      duck: false,
      fx: { ...NO_FX, eq: [], automation: [] },
      ...(fact.in > 0 ? { offset: fact.in } : {}),
      ...(fact.loop ? { loop: true } : {}),
    })
  }
  return tracks
}
