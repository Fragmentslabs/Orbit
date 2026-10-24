import fsp from 'node:fs/promises'
import path from 'node:path'
import { listMedia } from '../media'
import { panelSlidesPreview } from '../panel-browser'
import { readDeckSummary } from './slides-deck'
import { registerSlidesCover } from './slides-gallery'
import { getSlides, registerSlides } from './slides-store'

/** O deck já tem item na galeria? O `slidesId` é o vínculo, não a pasta. */
async function isInGallery(id: string): Promise<boolean> {
  try {
    const items = await listMedia({ kind: 'slides' })
    return items.some((item) => item.slidesId === id)
  } catch {
    return false
  }
}

/**
 * Abre um deck na aba Slides do painel e conta ao agente como ele ficou.
 *
 * Passo comum do `slides_preview` (modo código, deck na pasta do projeto) e do
 * `slides_write` (modo chat, deck no armazenamento do Orbit): registra a pasta,
 * manda o painel abrir (ou focar) a aba e lê o deck do DISCO — sem janela
 * offscreen, ao contrário do motion: o deck é HTML estático, e quantos slides
 * ele tem, com que título e que notas, se sabe lendo o arquivo.
 *
 * O relatório é o que fecha o ciclo: o agente fica sabendo na hora se escreveu
 * um `<section class="slide">` com o nome errado (zero slides) em vez de
 * descobrir pelo usuário olhando um palco vazio.
 */
export async function openSlidesAndReport(input: {
  /** Pasta do deck (ou o HTML de entrada), já resolvido e autorizado. */
  target: string
  /** Entrada explícita, quando `target` é a pasta. */
  entry?: string
  root?: string
  sessionId: string
  label: string
  nextStep: string
  /** Refaz a capa mesmo que o deck já esteja na galeria (deck reescrito). */
  refreshCover?: boolean
}): Promise<string> {
  const reg = await registerSlides(input.target, {
    entry: input.entry,
    root: input.root,
    sessionId: input.sessionId,
  })
  const name = path.basename(reg.folder)
  // O id faz o mesmo deck voltar à MESMA aba; `entry` é o caminho dentro da
  // pasta e `path` o absoluto, que a nota do chat devolve ao agente.
  panelSlidesPreview({
    id: reg.id,
    entry: path.relative(reg.folder, reg.entry).split(path.sep).join('/'),
    title: name,
    path: reg.entry,
    sessionId: input.sessionId,
  })

  const html = await fsp.readFile(reg.entry, 'utf8').catch(() => null)
  if (html === null) {
    return `Slides "${name}" is registered but ${reg.entry} could not be read — the tab will show an empty stage. Write the deck again and call this tool.`
  }
  const deck = readDeckSummary(html)
  if (deck.slides.length === 0) {
    return (
      `Deck "${name}" is open in the Slides tab of the right panel (${input.label}), but it has NO slides: ` +
      'no <section class="slide"> was found in the file. The user is looking at an empty stage — ' +
      'write each slide as <section class="slide">…</section> (one per slide, in order) and call slides_preview again.'
    )
  }

  // Galeria: a capa é o slide 1, e é o que faz o deck existir na aba Mídia
  // (sem isto ele só voltaria pelo card do chat). Best-effort — uma captura
  // falha deixa o item sem capa, nunca derruba a abertura.
  if (input.refreshCover || !(await isInGallery(reg.id))) {
    await registerSlidesCover(reg.id, { title: name, sessionId: input.sessionId }).catch(() => false)
  }

  const withNotes = deck.slides.filter((slide) => slide.notes).length
  const list = deck.slides
    .map((slide, index) => `${index + 1}. "${slide.title}"${slide.notes ? ' (has notes)' : ''}`)
    .join('; ')
  const count = deck.slides.length
  return [
    `Deck "${name}" is open in the Slides tab of the right panel (${input.label}) with ${count} slide${count === 1 ? '' : 's'}` +
      `${deck.title ? `, titled "${deck.title}"` : ''}: ${list}.` +
      (withNotes > 0 ? ` ${withNotes} of them have presenter notes.` : ''),
    'Navigation, scaling and notes are the app\'s: the deck file should stay content only (no JS of its own).',
    input.nextStep,
  ].join('\n')
}

/**
 * Reabre um deck que JÁ está no registro — o card do chat, o tile da galeria.
 * Sem `sessionId` de propósito: o renderer resolve o balde pelo chat ATIVO (ver
 * reopenMotion/reopenDesign, o mesmo raciocínio).
 */
export async function reopenSlides(id: string): Promise<boolean> {
  const entry = await getSlides(id)
  if (!entry) return false
  // Depois de reiniciar o app o registro volta do disco, mas o watcher não: sem
  // registrar de novo, o deck reaberto abriria sem recarga ao vivo. Idempotente.
  await registerSlides(entry.folder, { entry: entry.entry }).catch(() => {})
  panelSlidesPreview({
    id,
    entry: path.relative(entry.folder, entry.entry).split(path.sep).join('/'),
    title: path.basename(entry.folder),
    path: entry.entry,
  })
  return true
}
