import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { resolveAttachmentRef, type AttachmentKind, type ResolvedAttachment } from '../attachment-ref'
import { describeVideoFacts } from './attachment-note'
import { probeMedia } from './ffmpeg'

/**
 * Levar um ANEXO do chat para dentro de uma peça: o vídeo que o usuário mandou,
 * a foto, o GIF, o áudio. É a ponte entre "o agente tem uma referência" e "o
 * arquivo está ao lado do index.html, onde a peça o enxerga".
 *
 * O agente só chama isto quando decide USAR o material — anexar não copia nada
 * para peça nenhuma. E a referência é a única entrada: o caminho de origem nunca
 * vem do agente, só do anexo que a referência nomeia.
 */

/** Nome seguro para um arquivo dentro da pasta da peça (sem separadores, sem espaço). */
export function assetFileName(wanted: string | undefined, original: string, fallbackExt: string): string {
  const source = path.basename((wanted?.trim() || original || '').replace(/\\/g, '/'))
  const ext = (path.extname(source) || path.extname(original) || fallbackExt).toLowerCase()
  const stem = path
    .basename(source, path.extname(source))
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 48)
  return `${stem || 'asset'}${ext}`
}

/** Um nome que não pisa em outro arquivo da pasta; o mesmo conteúdo reaproveita o nome. */
async function freeName(folder: string, name: string, size: number): Promise<{ name: string; reuse: boolean }> {
  const ext = path.extname(name)
  const stem = path.basename(name, ext)
  for (let i = 1; i < 100; i++) {
    const candidate = i === 1 ? name : `${stem}-${i}${ext}`
    const existing = await fsp.stat(path.join(folder, candidate)).catch(() => null)
    if (!existing) return { name: candidate, reuse: false }
    if (existing.isFile() && existing.size === size) return { name: candidate, reuse: true }
  }
  throw new Error(`too many files named ${name} in the folder`)
}

export interface ImportedAsset {
  kind: AttachmentKind
  /** Nome do arquivo na pasta — é o que vai no `src` do HTML. */
  name: string
  file: string
  /** O texto que o agente lê: o que foi copiado, e como usar na peça. */
  report: string
}

/** Como usar cada tipo dentro de uma composição, em poucas linhas. */
function usage(kind: AttachmentKind, name: string, isGif: boolean, hasSound: boolean): string {
  if (kind === 'video') {
    return (
      `Use: <video src="${name}"></video> — style it with CSS (position, size, object-fit, object-view-box to crop). ` +
      'Timing in seconds on the piece: data-start (when it begins), data-in (where in the file), data-end (when it stops). ' +
      (hasSound
        ? 'Its sound is MIXED into the render unless you add the muted attribute (or data-audio="false"); lower it with data-gain="-6" under a narration.'
        : 'It has no audio stream, so there is no sound to manage.')
    )
  }
  if (kind === 'audio') {
    return `Use: declare it in audio.json next to index.html — { "tracks": [{ "file": "${name}", "start": 0 }] } (add it to the existing tracks if the manifest already exists; fields: start/end, gain, fadeIn/fadeOut, duck, preset, eq…).`
  }
  return isGif
    ? `Use: <img src="${name}"> — the GIF is decoded into frames, so it is deterministic. data-start (seconds on the piece) sets when it starts, data-loop="false" holds the last frame.`
    : `Use: <img src="${name}"> — style it with CSS; object-view-box crops it.`
}

/**
 * Copia o anexo da referência para `folder` e devolve o relatório. Idempotente: o
 * mesmo anexo duas vezes dá o mesmo arquivo, sem duplicar. `usageNote` troca a
 * linha de uso (design_asset fala em artboard; aqui dentro é linguagem de peça).
 */
export async function importAttachmentInto(
  folder: string,
  ref: string,
  wantedName?: string,
  opts: { usageNote?: string | ((kind: AttachmentKind, name: string) => string) } = {},
): Promise<ImportedAsset> {
  const resolved: ResolvedAttachment | null = await resolveAttachmentRef(ref)
  if (!resolved) {
    throw new Error(
      `attachment not found: ${ref}. Use the ref from the attachment note (vdo_…, aud_… or img_…) — it must belong to this app's attachments.`,
    )
  }
  const stat = await fsp.stat(resolved.file)
  const fallbackExt = path.extname(resolved.file) || ''
  const wanted = assetFileName(wantedName, resolved.name, fallbackExt)
  await fsp.mkdir(folder, { recursive: true })
  const { name, reuse } = await freeName(folder, wanted, stat.size)
  const target = path.join(folder, name)
  if (!reuse) await fsp.copyFile(resolved.file, target, fs.constants.COPYFILE_FICLONE)

  let facts = ''
  let hasSound = false
  if (resolved.kind === 'video' || resolved.kind === 'audio') {
    try {
      const probe = await probeMedia(target)
      hasSound = probe.audio.length > 0
      facts = describeVideoFacts(probe)
    } catch {
      facts = 'could not read the file'
    }
  }
  const isGif = resolved.kind === 'image' && path.extname(name).toLowerCase() === '.gif'
  const label = isGif ? 'GIF' : resolved.kind
  return {
    kind: resolved.kind,
    name,
    file: target,
    report: [
      `${reuse ? 'Already in the folder' : 'Copied'}: ${label} "${resolved.name}" → ${name}${facts ? ` (${facts})` : ''}.`,
      typeof opts.usageNote === 'function' ? opts.usageNote(resolved.kind, name) : (opts.usageNote ?? usage(resolved.kind, name, isGif, hasSound)),
      // A licença costuma exigir o crédito junto da imagem: ele viaja com ela até a peça.
      resolved.credit
        ? `CREDIT REQUIRED by the license (${resolved.credit.license}) — show it in the piece (a caption, or a credits card at the end): ${resolved.credit.attribution}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  }
}
