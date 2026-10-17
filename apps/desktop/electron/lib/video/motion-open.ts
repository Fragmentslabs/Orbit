import path from 'node:path'
import { listMedia } from '../media'
import { panelMotionPreview } from '../panel-browser'
import { motionAudioPlan, type MotionAudioPlan } from './motion-audio'
import { registerMotionCover } from './motion-gallery'
import { describeLayers, measureMotionLayers } from './motion-layers'
import { describeLint } from './motion-lint'
import { lintMotionComposition } from './motion-lint-run'
import { describeMasterFx, describeTrackFx } from './motion-audio-fx'
import { prepareMotionPreview } from './motion-preview'
import { describeTransitions } from './motion-transitions'
import { getMotion, registerMotion } from './motion-store'

/** A peça já tem item na galeria? O `motionId` é o vínculo, não a pasta. */
async function isInGallery(id: string): Promise<boolean> {
  try {
    const items = await listMedia({ kind: 'motion' })
    return items.some((item) => item.motionId === id)
  } catch {
    // Índice ilegível: trata como "não está", e o registro abaixo o reescreve.
    return false
  }
}

/**
 * Reabre uma peça que JÁ está no registro — o card do chat, o tile da Mídia.
 *
 * Não mede nem reporta nada: quem clicou quer ver a peça, não um relatório.
 * `false` quando a composição saiu do registro (uma peça de projeto apagado
 * some com ele), e aí quem chamou diz que ela não está mais lá.
 */
export async function reopenMotion(id: string): Promise<boolean> {
  const entry = await getMotion(id)
  if (!entry) return false
  // Depois de reiniciar o app o registro volta do disco, mas o watcher não: sem
  // registrar de novo a peça reaberta abriria sem recarga ao vivo. É idempotente
  // (mesmo id, mesma entrada) e só religa o watcher.
  await registerMotion(entry.folder, entry.entry).catch(() => {})
  // Sem `sessionId` de propósito: o renderer resolve o balde pelo chat ATIVO. A
  // sessão gravada no registro é a de ORIGEM — para uma peça antiga é outra
  // conversa, e a aba nasceria num painel que não está na tela (o clique
  // parecia não fazer nada).
  panelMotionPreview({
    id,
    entry: path.relative(entry.folder, entry.entry),
    title: path.basename(entry.folder),
    path: entry.entry,
  })
  return true
}

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
    // A peça entra na galeria na PRIMEIRA vez que abre: é isso que a deixa
    // reabrível quando a aba do painel for fechada. Uma vez só (a capa custa uma
    // janela offscreen a mais) e best-effort — o preview nunca depende disso.
    if (!(await isInGallery(preview.id))) {
      await registerMotionCover(preview.id, { sessionId: input.sessionId }).catch(() => false)
    }
    // As faixas entram no relatório: o agente precisa saber que a peça JÁ tem som
    // (a aba o toca com o preview e o render o mistura) e em que instantes, antes
    // de mexer no comprimento dela ou de reescrever a composição.
    let audio = ''
    let plan: MotionAudioPlan | null = null
    try {
      plan = await motionAudioPlan(preview.folder)
      const { tracks, master } = plan
      if (tracks.length) {
        audio = `Audio (${tracks.length} track${tracks.length > 1 ? 's' : ''} declared in audio.json, mixed by the render): ${tracks
          .map((track) => {
            const span = track.end === undefined ? `${track.start}s→end` : `${track.start}s→${track.end}s`
            const level = track.gainDb === 0 ? '' : `, ${track.gainDb}dB`
            const bed = track.duck ? ', ducked under the others' : ''
            const treated = describeTrackFx(track.fx)
            const where = track.path ? '' : ', OUTSIDE the composition folder (the tab cannot play it)'
            return `"${track.name}" (${span}${level}${bed}${treated ? `, ${treated}` : ''}${where})`
          })
          .join('; ')}.`
        const finish = describeMasterFx(master)
        if (finish) audio += ` Master: ${finish}.`
      }
    } catch (err) {
      audio = `Audio: the manifest in the composition folder is broken — ${err instanceof Error ? err.message : String(err)}. The render will fail on it.`
    }
    // O lint junta o que só se vê no texto da composição (relógio de parede,
    // arquivo que falta…) com o que só se vê rodando (transição fora da peça,
    // faixa de áudio depois do fim).
    const lint = await lintMotionComposition({
      entry: preview.file,
      folder: preview.folder,
      runtime: { fps: measured.fps, durationInFrames: measured.durationInFrames, transitions: measured.transitions },
      audio: plan,
    })
    return [
      `Motion "${name}" is open in the Motion tab of the right panel (${input.label}) and loads fine: ${measured.width}x${measured.height}, ${measured.durationInFrames} frames at ${measured.fps} fps (${(measured.durationInFrames / measured.fps).toFixed(2)} s).`,
      measured.failedFonts.length ? `Fonts that failed to load: ${measured.failedFonts.join(', ')}.` : '',
      audio,
      describeTransitions(measured.transitions),
      'Layers (when each enters and leaves the frame):',
      describeLayers(measured.layers, measured.fps),
      describeLint(lint),
      input.nextStep,
    ]
      .filter(Boolean)
      .join('\n')
  } catch (err) {
    // A composição não carregou: o lint estático (sem rodar nada) costuma apontar
    // o motivo — um arquivo que falta, um script que não existe.
    const lint = await lintMotionComposition({ entry: preview.file, folder: preview.folder })
    return [
      `Motion "${name}" is open in the Motion tab, but it DID NOT LOAD: ${err instanceof Error ? err.message : String(err)}. ` +
        `The user is looking at an empty stage — ${input.fixHint}`,
      lint.length ? describeLint(lint) : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
}
