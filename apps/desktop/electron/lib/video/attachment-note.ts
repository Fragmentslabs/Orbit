import sharp from 'sharp'
import { probeMedia, runFfmpeg, type MediaProbe } from './ffmpeg'

/**
 * O que o agente lê (e o que a bolha mostra) de um vídeo anexado.
 *
 * A nota é de propósito curta: nome, referência e uma linha de metadados. O
 * vídeo em si não entra no contexto — o agente decide, pela necessidade do
 * pedido, se vale transcrever, olhar um trecho ou levar o arquivo para uma
 * peça. Um depoimento de 30 minutos custa as mesmas ~80 palavras que um clipe
 * de 3 segundos.
 */

/** Uma linha com o que o `ffprobe` diz do arquivo; vazia se não foi possível sondar. */
export function describeVideoFacts(probe: MediaProbe | null): string {
  if (!probe) return 'Could not read the file (it may be corrupt or an unsupported codec).'
  const v = probe.video[0]
  const a = probe.audio[0]
  const parts = [
    `${(probe.durationMs / 1000).toFixed(1)} s`,
    v ? `${probe.display?.width ?? v.width}x${probe.display?.height ?? v.height} @ ${Math.round(v.fps * 100) / 100} fps` : 'no video stream',
    a ? `audio ${a.channels}ch` : 'NO audio',
    `${(probe.sizeBytes / 1e6).toFixed(1)} MB`,
  ]
  return parts.join(', ')
}

/** A nota do anexo, em inglês como as demais notas que o agente recebe. */
export function videoAttachmentNote(input: {
  filename: string
  id: string
  file: string
  probe: MediaProbe | null
  /** O anexo foi recusado (grande demais, ilegível): a nota diz por quê. */
  problem?: string
}): string {
  const head = `[Video attached: ${input.filename || 'unnamed'} — ref ${input.id}]`
  if (input.problem) return `${head}\n(${input.problem})`
  const hasSound = (input.probe?.audio.length ?? 0) > 0
  return [
    head,
    `File: ${input.file} (in this app's attachments)`,
    describeVideoFacts(input.probe),
    '(Attachment, not a user message. It is NOT watched and NOT transcribed: only this description is in your context. ' +
      `Read it when the request needs it, using ref "${input.id}": video_probe for the details, ` +
      (hasSound ? 'video_transcribe for what is SAID, ' : '') +
      'video_timeline to look at a short window. ' +
      'To use it INSIDE a piece (a clip in a motion composition, its sound, a cut) call motion_asset with this ref — do that only if the request is about using this video.)',
  ].join('\n')
}

/** Sonda o arquivo sem nunca falhar: `null` quando o ffprobe não o entende. */
export async function probeVideoAttachment(file: string): Promise<MediaProbe | null> {
  try {
    return await probeMedia(file)
  } catch {
    return null
  }
}

/**
 * Um quadro do vídeo como imagem PNG (até 480 px de largura): é a capa do item na
 * galeria. Não é o quadro 0, que costuma ser preto: um pouco adiante, sem passar
 * do meio. `undefined` quando o ffmpeg não consegue ler o arquivo.
 */
export async function videoPosterPng(file: string, durationMs: number): Promise<Buffer | undefined> {
  try {
    const at = Math.min(1, durationMs / 1000 / 2)
    const { stdout } = await runFfmpeg(
      ['-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      {},
    )
    if (!stdout.length) return undefined
    return await sharp(stdout).resize({ width: 480, withoutEnlargement: true }).png().toBuffer()
  } catch {
    return undefined
  }
}

/** A capa em miniatura (WebP, até 320 px) para a bolha do chat, como data URL. */
export async function posterDataUrl(png: Buffer): Promise<string | undefined> {
  try {
    const out = await sharp(png).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer()
    return `data:image/webp;base64,${out.toString('base64')}`
  } catch {
    return undefined
  }
}

/**
 * A referência de uma imagem ou GIF guardados, para o agente poder usá-los como
 * material (motion_asset). Uma linha: a imagem em si segue o caminho de sempre
 * (visão nativa, ou describe_image no modo Visão). Vazia quando a imagem não foi
 * guardada.
 */
export function imageRefLine(mediaUrl: string | undefined, filename: string, mime: string): string {
  const id = mediaUrl ? mediaUrl.replace(/^orbit-media:\/\//, '') : ''
  if (!id) return ''
  const kind = mime === 'image/gif' || /\.gif$/i.test(filename) ? 'GIF (animated)' : 'Image'
  return `[${kind} file: ${filename || 'unnamed'} — ref ${id}] (to place it in a motion piece call motion_asset, or in a design canvas design_asset, with this ref; otherwise ignore this line.)`
}
