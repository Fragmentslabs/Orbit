import { tool, type ToolSet } from 'ai'
import path from 'node:path'
import { z } from 'zod'
import { openSlidesAndReport } from '../slides/slides-open'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Slides no MODO CÓDIGO (precisa de pasta) — espelha design_preview: a tool não
 * ESCREVE nada, só registra uma pasta que o agente já escreveu com write/edit e
 * abre (ou foca) a aba Slides, onde o usuário apresenta e acompanha ao vivo.
 *
 * O deck é UM arquivo (`index.html` com um `<section class="slide">` por
 * slide), e é isso que o torna barato de escrever: uma chamada de `write` para
 * o deck inteiro, em vez do `canvas.json` + um arquivo por artboard do design.
 */
export function createSlidesTools(ctx: ToolContext, scope: { sessionId: string }): ToolSet {
  const rel = (abs: string) => path.relative(ctx.directory, abs) || abs

  return {
    slides_preview: tool({
      description:
        'Opens a slide deck in the Slides tab of the right panel, where the USER can present and watch it live. It does NOT write anything: write the deck yourself first (with write/edit), then call this to open or refresh the tab. ' +
        'The deck is ONE self-contained HTML file — `<section class="slide">…</section>` per slide, in order, and nothing else: navigation, 16:9 scaling, slide list, presenter notes and fullscreen belong to the app, so the deck must NOT bring a runtime, build step or its own navigation script. ' +
        'Rules: (1) one `<section class="slide">` per slide, each with a single idea; (2) optional `data-title="…"` on the section names the slide in the tab (otherwise its first h1/h2/h3 is used); (3) presenter notes go in `<aside class="notes">…</aside>` inside the slide and are hidden on stage; (4) the document should be styled by its own `<style>` (the deck is HTML/CSS, no template syntax), and a `<meta name="orbit-slides" content="width=1280,height=720">` may declare another stage size; (5) put `<style>` in the head and nothing but the sections in the body. ' +
        'Use it whenever the user asks for a presentation, a deck or slides, instead of create_artifact — a deck authored this way can be presented in fullscreen, navigated with the keyboard and read slide by slide. ' +
        'path: the deck folder (containing index.html) or the .html itself, inside the working folder. After the first call, keep editing the file with write/edit — the tab reloads live; call slides_preview again only if the tab needs to (re)focus.',
      inputSchema: z.object({
        path: z
          .string()
          .describe('The deck folder (containing index.html) or the deck .html file, inside the working folder'),
      }),
      execute: async ({ path: p }) => {
        const target = resolveSafePath(ctx, p)
        return openSlidesAndReport({
          target,
          root: ctx.directory,
          sessionId: scope.sessionId,
          label: rel(target),
          nextStep:
            'Keep editing the deck file with write/edit — the tab reloads live and keeps the current slide. Call slides_preview again only to (re)focus the tab or confirm the new slide count.',
        })
      },
    }),
  }
}
