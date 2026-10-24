import { tool, type ToolSet } from 'ai'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { withAssetLock, writeFileAtomic } from '../asset-lock'
import { buildDeckHtml } from '../slides/deck-template'
import { chatSlidesDir } from '../slides/slides-store'
import { slidesSlug } from '../slides/slides-slug'
import { openSlidesAndReport } from '../slides/slides-open'

/**
 * Slides no MODO CHAT — o deck mora no armazenamento do Orbit
 * (`orbit-data/slides/<sessão>/<nome>/index.html`), sem pasta de trabalho.
 *
 * Esta é a porta RÁPIDA: o conteúdo dos slides entra na própria chamada da tool
 * (uma por slide, como o create_artifact recebe o HTML), e o main monta o
 * arquivo, registra e abre a aba. Nenhum `write` intermediário, nenhuma
 * coordenada para inventar — é a ergonomia do artifact com o palco do painel.
 *
 * O deck sai com um tema da casa (fundo escuro, acento dourado, tipografia
 * grande) e classes de apoio (`.cover`, `.grid`, `.card`, `.kicker`, `.lead`,
 * `.stat`, `.quote`) para o modelo montar slides bonitos sem escrever CSS. Quem
 * quiser controle total usa o modo código (`slides_preview` sobre um arquivo do
 * projeto).
 */

const SLIDE = z.object({
  title: z
    .string()
    .max(120)
    .optional()
    .describe('Short name of the slide, shown in the tab list and in the deck report (default: its first h1/h2/h3)'),
  html: z
    .string()
    .min(1)
    .describe(
      'The slide body as HTML — real content, no <section> wrapper (the tool adds it), no <script>. ' +
        'Use classes .cover (title slide), .section (divider), .kicker, .lead, .grid.cols-2/.cols-3, .card, .stat/.stat-value/.stat-label, .quote, .pill. ' +
        'Aim for one idea per slide: a headline and at most ~5 short points.',
    ),
  notes: z
    .string()
    .optional()
    .describe('Presenter notes for this slide (what to SAY), hidden on stage and shown in the Notes panel'),
})

export function createChatSlidesTools(scope: { sessionId: string }): ToolSet {
  return {
    slides_write: tool({
      description:
        'Creates (or replaces) a slide deck in the chat and opens it in the Slides tab of the right panel — the fastest way to make a presentation, because the whole deck comes in ONE call, like create_artifact. ' +
        'The deck is built from an array of slides; the app supplies the house theme (dark, gold accent, large type), the 16:9 stage, navigation, the slide list, presenter notes and fullscreen. Do NOT write CSS, JS or navigation — describe the slides. ' +
        'Use the helper classes: .cover (opening), .section (divider), .kicker (small uppercase label), .lead (large intro line), .grid.cols-2 / .cols-3 / .cols-4 with .card, .stat + .stat-value + .stat-label (a number worth reading), .quote. One idea per slide, a headline and at most ~5 short points. ' +
        'Addressing the deck later: the same `title` rewrites the same deck (send all slides again — this tool replaces, it does not patch). For a deck that lives in the project as a file, use slides_preview instead.',
      inputSchema: z.object({
        title: z
          .string()
          .min(1)
          .max(80)
          .describe('Deck title — also its address in this conversation (e.g. "Orbit em 12 slides")'),
        slides: z.array(SLIDE).min(1).max(60).describe('The slides, in presentation order'),
        lang: z
          .string()
          .length(2)
          .optional()
          .describe('Language of the deck html element (default: pt-BR). The slide TEXT is not translated by this'),
      }),
      execute: async ({ title, slides, lang }) => {
        const name = slidesSlug(title)
        const folder = path.join(chatSlidesDir(scope.sessionId), name)
        const entry = path.join(folder, 'index.html')
        const html = buildDeckHtml({ title, slides, lang })
        await fs.mkdir(folder, { recursive: true })
        await withAssetLock(`slides:${folder}`, () => writeFileAtomic(entry, html))
        return openSlidesAndReport({
          target: folder,
          root: chatSlidesDir(scope.sessionId),
          sessionId: scope.sessionId,
          label: `deck "${name}" in this conversation`,
          // O `slides_write` SUBSTITUI o deck inteiro: a capa antiga
          // mostraria um slide que talvez nem exista mais.
          refreshCover: true,
          nextStep:
            'To change it, call slides_write again with the SAME title and every slide (it replaces the deck), or slide by slide through slides_preview if the deck is a file in the project.',
        })
      },
    }),
  }
}
