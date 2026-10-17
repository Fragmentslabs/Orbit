import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { MediaEntry, MediaSource } from '@shared/media'
import { listMedia, saveVideoMedia } from '../media'
import type { MediaProbe } from './ffmpeg'
import { probeVideoAttachment, videoPosterPng } from './attachment-note'
import { registerVideo } from './store'

/**
 * Põe um vídeo na GALERIA de mídia: o anexo que o usuário mandou e o vídeo que o
 * agente produziu no modo chat. É o que os faz aparecerem na aba Mídia, no filtro
 * de tipo, e poderem ser excluídos de lá — liberando o arquivo.
 *
 * Só entra aqui o que o app GUARDA. Um vídeo renderizado na pasta de um projeto
 * (modo código) é arquivo do projeto, não do app: a galeria não o lista, porque
 * excluir um item de lá apagaria um arquivo do usuário.
 */

/** Id do item na galeria: o do anexo (`vdo_…`) ou um novo, para um vídeo produzido. */
function newVideoId(file: string): string {
  const ext = path.extname(file).toLowerCase().replace(/^\./, '') || 'mp4'
  return `vdo_${Date.now().toString(36)}${randomBytes(4).toString('hex')}.${ext}`
}

export interface GalleryVideo {
  entry: MediaEntry
  /** A capa em PNG (para quem precisa dela de novo, como o chip da bolha). */
  poster?: Buffer
  probe: MediaProbe | null
}

export async function addVideoToGallery(input: {
  file: string
  /** Mantém o id quando o arquivo JÁ é um anexo guardado (`vdo_…`). */
  id?: string
  name?: string
  sessionId?: string
  messageId?: string
  source: MediaSource
  probe?: MediaProbe | null
}): Promise<GalleryVideo> {
  const probe = input.probe === undefined ? await probeVideoAttachment(input.file) : input.probe
  const poster = probe ? await videoPosterPng(input.file, probe.durationMs) : undefined
  // O mesmo arquivo (um render refeito por cima do anterior) é o MESMO item: a
  // galeria não ganha um cartão novo a cada execução.
  const id = input.id ?? (await listMedia({ kind: 'video' })).find((e) => e.path === input.file)?.id ?? newVideoId(input.file)
  const { url } = await registerVideo(input.file, input.sessionId)
  const size = (await fsp.stat(input.file)).size
  const first = probe?.video[0]
  const entry = await saveVideoMedia(poster ?? null, {
    id,
    file: input.file,
    size,
    name: input.name ?? path.basename(input.file),
    sessionId: input.sessionId,
    messageId: input.messageId,
    source: input.source,
    width: probe?.display?.width ?? first?.width,
    height: probe?.display?.height ?? first?.height,
    durationMs: probe?.durationMs,
    videoUrl: url,
  })
  return { entry, poster, probe }
}
