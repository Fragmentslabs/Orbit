import fsp from 'node:fs/promises'
import path from 'node:path'
import { isMotionAudioFile } from './motion-render-args'

/**
 * O ÁUDIO de uma composição de motion: QUAIS arquivos são, quando cada um entra e
 * como o preview os alcança.
 *
 * A captura de quadros não pega som (janela offscreen + rawvideo no stdin), então
 * as trilhas entram numa passada final do render (motion.ts), que as posiciona e
 * mistura com o grafo de filtros do motion-render-args. Para que o que o usuário
 * ouve na aba seja o que sai no arquivo, quem escolhe o áudio é só este módulo: o
 * render, as faixas que a aba desenha e o que o agente lê no motion_preview saem
 * todos daqui.
 *
 * Três portas, nesta ordem:
 *  1. caminho explícito (a tool manda o arquivo que acabou de gerar) — uma faixa,
 *     a peça inteira;
 *  2. `audio.json` na pasta da composição — o manifest, com quantas faixas quiser,
 *     cada uma no seu instante (música de fundo, efeito pontual, narração);
 *  3. o nome convencional solto na pasta (`audio.mp3`, `audio.wav`…) — uma faixa.
 */

/** O manifest da pasta: é ele que declara as faixas e os instantes. */
export const MOTION_AUDIO_MANIFEST = 'audio.json'

export interface MotionAudioTrack {
  /** Caminho absoluto — é o que o ffmpeg do render abre. */
  file: string
  /** Nome para a interface: o rótulo do manifest, ou o nome do arquivo. */
  name: string
  /**
   * Caminho relativo à pasta, já escapado (`voz.mp3`, `audio/voz.mp3`): é o que
   * o scheme serve em `orbit-motion://<id>/<path>`. `null` quando o arquivo está
   * FORA da pasta — o render o muxa (o ffmpeg abre o caminho absoluto), mas o
   * scheme não serve nada fora da composição, então o preview não o toca.
   */
  path: string | null
  /** Segundo da peça em que a faixa ENTRA. */
  start: number
  /** Segundo da peça em que ela SAI; ausente = até o fim do arquivo. */
  end?: number
  /** Nível em dB (0 = como está). */
  gainDb: number
  /** Rampas de entrada e saída, em segundos. */
  fadeIn: number
  fadeOut: number
  /** Cama que abaixa sozinha enquanto as outras faixas estão tocando. */
  duck: boolean
}

/** O que o manifest aceita por faixa: só `file` é obrigatório. */
interface ManifestTrack {
  file: string
  name?: string
  start?: number
  end?: number
  gain?: number
  fadeIn?: number
  fadeOut?: number
  duck?: boolean
}

/**
 * As faixas da composição, na ordem em que o manifest as declarou (a ordem não
 * muda o som, mas muda a lista que a aba desenha).
 *
 * O caminho explícito manda — e PRECISA existir: pedir um áudio que não está lá é
 * erro, não silêncio. O manifest também: faixa sem `file`, arquivo que não existe
 * ou JSON quebrado são erro com o motivo. Uma trilha declarada que some em
 * silêncio é pior que um render que falha dizendo o que houve.
 */
export async function motionAudioTracks(folder: string, explicit?: string): Promise<MotionAudioTrack[]> {
  const root = path.resolve(folder)
  if (explicit) return [await one(root, path.resolve(explicit), path.basename(explicit), {})]
  const declared = await manifest(root)
  if (declared) {
    return Promise.all(
      declared.map((entry) =>
        one(root, path.resolve(root, entry.file), entry.name?.trim() || path.basename(entry.file), entry),
      ),
    )
  }
  const loose = await conventionalAudio(root)
  return loose ? [await one(root, loose, path.basename(loose), {})] : []
}

/** Uma faixa: arquivo conferido, caminho servível calculado, defaults aplicados. */
async function one(
  root: string,
  file: string,
  name: string,
  // Sem `file`: o caminho já veio resolvido por quem chamou (o manifest só
  // declara o resto).
  spec: Omit<ManifestTrack, 'file'>,
): Promise<MotionAudioTrack> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`audio file not found: ${file}`)
  const relative = path.relative(root, file)
  const inside = relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
  const start = seconds(spec.start, 0)
  return {
    file,
    name,
    path: inside ? relative.split(path.sep).map((segment) => encodeURIComponent(segment)).join('/') : null,
    start,
    // Fim que não é depois do começo seria uma faixa que nunca toca: quem escreveu
    // se enganou, e o mais útil é tocar o arquivo inteiro a partir do `start` do
    // que sumir com a faixa sem dizer nada.
    ...(isAfter(spec.end, start) ? { end: spec.end as number } : {}),
    gainDb: number(spec.gain, 0),
    fadeIn: Math.max(0, seconds(spec.fadeIn, 0)),
    fadeOut: Math.max(0, seconds(spec.fadeOut, 0)),
    duck: spec.duck === true,
  }
}

/**
 * O manifest da pasta, ou null quando não existe. Aceita `{ "tracks": [...] }` e a
 * lista solta; `file` é o único campo obrigatório, e o resto tem padrão.
 */
async function manifest(root: string): Promise<ManifestTrack[] | null> {
  const raw = await fsp.readFile(path.join(root, MOTION_AUDIO_MANIFEST), 'utf8').catch(() => null)
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${MOTION_AUDIO_MANIFEST} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { tracks?: unknown } | null)?.tracks
  if (!Array.isArray(list)) {
    throw new Error(`${MOTION_AUDIO_MANIFEST} must be a list of tracks, or an object with a "tracks" list`)
  }
  return list.map((entry, index) => {
    const track = (entry ?? {}) as Partial<ManifestTrack>
    const file = typeof track.file === 'string' ? track.file.trim() : ''
    if (!file) throw new Error(`${MOTION_AUDIO_MANIFEST}: track ${index + 1} has no "file"`)
    return { ...track, file }
  })
}

/** O `audio.<ext>` da pasta, se houver (ordem estável quando há mais de um). */
async function conventionalAudio(folder: string): Promise<string | null> {
  const entries = await fsp.readdir(folder).catch(() => null)
  const name = entries?.filter((entry) => isMotionAudioFile(entry)).sort()[0]
  return name ? path.join(folder, name) : null
}

function isAfter(value: unknown, start: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > start
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
