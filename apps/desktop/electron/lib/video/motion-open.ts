import path from 'node:path'
import { panelMotionPreview } from '../panel-browser'
import { motionAudioTracks } from './motion-audio'
import { describeLayers, measureMotionLayers } from './motion-layers'
import { prepareMotionPreview } from './motion-preview'

/**
 * Abre uma composição na aba Motion e conta ao agente como ela ficou.
 *
 * É o passo comum do `motion_preview` (modo código, composição na pasta do
 * projeto) e do `motion_write`/`motion_edit` (modo chat, composição no
 * armazenamento do Orbit): registra a pasta, manda o painel abrir (ou focar) a
 * aba e MEDE a composição na mesma janela offscreen que a aba usa — o agente
 * fica sabendo agora se ela carrega e quem entra e sai, e quando, em vez de
 * descobrir pelo usuário reclamando de uma tela girando.
 */
export async function openMotionAndReport(input: {
  /** Entrada .html (ou a pasta dela), já resolvida e autorizada. */
  target: string
  /** Pasta de trabalho que registra a composição. */
  root?: string
  sessionId: string
  /** Como o agente chama a composição no texto (caminho relativo ou nome). */
  label: string
  /** O que fazer a seguir, dito na linguagem das tools que o agente tem. */
  nextStep: string
  /** O que fazer quando não carregou. */
  fixHint: string
}): Promise<string> {
  const preview = await prepareMotionPreview(input.target, { root: input.root, sessionId: input.sessionId })
  const name = path.basename(preview.folder)
  // O id faz a mesma composição voltar à MESMA aba; `entry` é o caminho dentro
  // da pasta e `path` o absoluto, que a nota do chat devolve ao agente.
  panelMotionPreview({ id: preview.id, entry: preview.entry, title: name, path: preview.file, sessionId: input.sessionId })
  try {
    const measured = await measureMotionLayers(preview.id, preview.url)
    // As faixas entram no relatório: o agente precisa saber que a peça JÁ tem som
    // (a aba o toca com o preview e o render o mistura) e em que instantes, antes
    // de mexer no comprimento dela ou de reescrever a composição.
    let audio = ''
    try {
      const tracks = await motionAudioTracks(preview.folder)
      if (tracks.length) {
        audio = `Audio (${tracks.length} track${tracks.length > 1 ? 's' : ''} declared in audio.json, mixed by the render): ${tracks
          .map((track) => {
            const span = track.end === undefined ? `${track.start}s→end` : `${track.start}s→${track.end}s`
            const level = track.gainDb === 0 ? '' : `, ${track.gainDb}dB`
            const bed = track.duck ? ', ducked under the others' : ''
            const where = track.path ? '' : ', OUTSIDE the composition folder (the tab cannot play it)'
            return `"${track.name}" (${span}${level}${bed}${where})`
          })
          .join('; ')}.`
      }
    } catch (err) {
      audio = `Audio: the manifest in the composition folder is broken — ${err instanceof Error ? err.message : String(err)}. The render will fail on it.`
    }
    return [
      `Motion "${name}" is open in the Motion tab of the right panel (${input.label}) and loads fine: ${measured.width}x${measured.height}, ${measured.durationInFrames} frames at ${measured.fps} fps (${(measured.durationInFrames / measured.fps).toFixed(2)} s).`,
      measured.failedFonts.length ? `Fonts that failed to load: ${measured.failedFonts.join(', ')}.` : '',
      audio,
      'Layers (when each enters and leaves the frame):',
      describeLayers(measured.layers, measured.fps),
      input.nextStep,
    ]
      .filter(Boolean)
      .join('\n')
  } catch (err) {
    return (
      `Motion "${name}" is open in the Motion tab, but it DID NOT LOAD: ${err instanceof Error ? err.message : String(err)}. ` +
      `The user is looking at an empty stage — ${input.fixHint}`
    )
  }
}
