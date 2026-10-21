import { tool, type ToolSet } from 'ai'
import path from 'node:path'
import { z } from 'zod'
import { openDesignAndReport } from '../design/design-open'
import { resolveSafePath, type ToolContext } from './context'

/**
 * Design no MODO CÓDIGO (precisa de pasta) — espelha motion_preview em
 * video.ts: a tool não ESCREVE nada, só registra uma pasta que o agente já
 * escreveu com write/edit e abre (ou foca) a aba Design, onde o usuário
 * acompanha ao vivo. Diferente do motion, não há "entrada" — o canvas inteiro
 * (canvas.json + os artboards) é a pasta.
 */
export function createDesignTools(ctx: ToolContext, scope: { sessionId: string }): ToolSet {
  const rel = (abs: string) => path.relative(ctx.directory, abs) || abs

  return {
    design_preview: tool({
      description:
        'Opens a design canvas — one or more self-contained HTML "artboards" laid out on an infinite canvas, like a Figma board — in the Design tab of the right panel, where the USER watches it live. It does NOT write anything: write canvas.json and the artboard .html files yourself first (with write/edit), then call this to open or refresh the tab. ' +
        'Use this — NOT create_artifact — whenever the user wants a visual design to look at: a logo, a UI mockup/wireframe, a landing page, a poster, several screens or variants to compare, or "design mode"/"modo design". ' +
        'canvas.json shape: {"v":1,"title"?:string,"boards":{"<file>.html":{"title"?:string,"x":number,"y":number,"w":number,"h":number}},"order":["<file>.html",…]}. Each artboard is a COMPLETE, self-contained HTML document (real HTML/CSS — flex/grid for layout, inline SVG for marks/icons — no template syntax, no shared runtime, no build step). To make a CLICKABLE prototype, link the artboards with plain relative anchors (<a href="Pricing.html">): the artboard that links to another gets a Play button. Lay artboards side by side (80px gap is typical) so none overlap; prefer several artboards when a direction is still open (e.g. 2-4 logo concepts side by side) — the canvas is built for comparing options. ' +
        'path: the canvas folder (containing canvas.json), inside the working folder. After the first call, keep editing those files with write/edit — the tab reloads live; call design_preview again only if the tab needs to (re)focus.',
      inputSchema: z.object({
        path: z.string().describe('The canvas folder (containing canvas.json), inside the working folder'),
      }),
      execute: async ({ path: p }) => {
        const target = resolveSafePath(ctx, p)
        return openDesignAndReport({
          target,
          root: ctx.directory,
          sessionId: scope.sessionId,
          label: rel(target),
          nextStep:
            'Keep editing canvas.json and the artboard files with write/edit — the tab reloads live. Call design_preview again only to (re)focus the tab or confirm the new layout.',
        })
      },
    }),
  }
}
