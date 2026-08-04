import { tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { saveMedia } from '../media'
import {
  panelClick,
  panelNavigate,
  panelRead,
  panelResize,
  panelScreenshot,
  panelType,
} from '../panel-browser'
import { resolveSafePath, type ToolContext } from './context'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
/** Limite de tamanho para imagem enviada ao modelo via toModelOutput (300KB). */
const MAX_MODEL_IMAGE_BYTES = 300_000

/** Presets de viewport para teste de responsividade. */
const VIEWPORT_PRESETS: Record<string, { width: number | null; height: number | null; label: string }> = {
  mobile: { width: 390, height: 844, label: 'mobile (390×844)' },
  tablet: { width: 834, height: 1112, label: 'tablet (834×1112)' },
  desktop: { width: 1440, height: 900, label: 'desktop (1440×900)' },
  fit: { width: null, height: null, label: 'ajustado ao painel' },
}

/**
 * Ferramentas do browser do painel direito (modo código). O painel abre
 * sozinho quando o agente usa qualquer uma. O screenshot volta como IMAGEM
 * para o modelo (toModelOutput com content file) — o base64 fica num stash
 * por toolCallId para não inflar o histórico persistido.
 */

const screenshotStash = new Map<string, string>()

export function createPanelBrowserTools(ctx: ToolContext): ToolSet {
  return {
    panel_navigate: tool({
      description:
        'Opens a URL in the Orbit right panel browser (the panel opens on its own). Use it to test web apps — local servers (http://localhost:...) included.',
      inputSchema: z.object({
        url: z.string().describe('Full URL (http/https)'),
      }),
      execute: async ({ url }) => {
        const result = await panelNavigate(ctx.sessionId, url)
        return `Carregado: ${result.title || '(sem título)'} — ${result.url}. Use panel_read para ver o conteúdo ou panel_screenshot para ver a tela.`
      },
    }),
    panel_read: tool({
      description:
        'Reads the page open in the panel browser: title, URL, visible text, and interactive elements with numbered refs for panel_click/panel_type.',
      inputSchema: z.object({}),
      execute: async () => panelRead(ctx.sessionId),
    }),
    panel_click: tool({
      description:
        'Clicks an element on the panel page, by ref (from panel_read) or CSS selector. Refs change after navigation — run panel_read again.',
      inputSchema: z.object({
        ref: z.number().int().optional().describe('Numeric ref from panel_read'),
        selector: z.string().optional().describe('CSS selector (alternative to ref)'),
      }),
      execute: async ({ ref, selector }) => {
        if (ref == null && !selector) return 'Informe ref ou selector.'
        return panelClick(ctx.sessionId, ref, selector)
      },
    }),
    panel_type: tool({
      description:
        'Types text into a field on the panel page (by ref or CSS selector), with the option to submit the form.',
      inputSchema: z.object({
        text: z.string().describe('Text to type'),
        ref: z.number().int().optional().describe('Numeric ref from panel_read'),
        selector: z.string().optional().describe('CSS selector (alternative to ref)'),
        pressEnter: z.boolean().optional().describe('Submits the form after typing'),
      }),
      execute: async ({ text, ref, selector, pressEnter }) => {
        if (ref == null && !selector) return 'Informe ref ou selector.'
        return panelType(ctx.sessionId, text, ref, selector, pressEnter)
      },
    }),
    panel_resize: tool({
      description:
        'Resizes the panel browser\'s viewport to test responsiveness. Use a preset (mobile/tablet/desktop/fit) or custom width/height. Then use panel_screenshot to see the result.',
      inputSchema: z.object({
        preset: z.enum(['mobile', 'tablet', 'desktop', 'fit']).optional(),
        width: z.number().int().min(280).max(3840).optional().describe('Custom width in px'),
        height: z.number().int().min(400).max(2160).optional().describe('Custom height in px'),
      }),
      execute: async ({ preset, width, height }) => {
        if (width && height) return panelResize(ctx.sessionId, width, height, `${width}×${height}`)
        const chosen = VIEWPORT_PRESETS[preset ?? 'fit']
        return panelResize(ctx.sessionId, chosen.width, chosen.height, chosen.label)
      },
    }),
    panel_screenshot: tool({
      description:
        'Takes a screenshot of the panel page and SEES it as an image. With savePath, also saves the WebP to the working folder (e.g.: docs/login/screen.webp) — use in documentation mode. With fullscreen, expands to full screen, captures the whole screen, and returns to the side view.',
      inputSchema: z.object({
        savePath: z
          .string()
          .optional()
          .describe('Path relative to the working folder to save the WebP (optional)'),
        fullscreen: z
          .boolean()
          .optional()
          .describe('Captures full screen (bigger shot) and returns to the side view'),
      }) as any,
      execute: async ({ savePath, fullscreen }, { toolCallId }) => {
        const webp = await panelScreenshot(ctx.sessionId, fullscreen === true)
        screenshotStash.set(toolCallId, webp.toString('base64'))
        let saved = ''
        if (savePath) {
          const saveName = savePath.replace(/\.[^/.]+$/, '') + '.webp'
          const target = resolveSafePath(ctx, saveName)
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.writeFile(target, webp)
          saved = ` Salvo em ${saveName}.`
        }
        return `Screenshot capturado (${Math.round(webp.length / 1024)}KB).${saved}`
      },
      toModelOutput: ({ toolCallId, output }) => {
        const base64 = screenshotStash.get(toolCallId)
        screenshotStash.delete(toolCallId)
        if (!base64) return { type: 'text', value: String(output) }
        const raw = Buffer.from(base64, 'base64')
        const parts: ({ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string })[] = [
          { type: 'text', text: String(output) },
        ]
        if (raw.length <= MAX_MODEL_IMAGE_BYTES) {
          parts.push({ type: 'image-data', data: base64, mediaType: 'image/webp' })
        } else {
          parts.push({
            type: 'text',
            text: `[Screenshot omitido: ${Math.round(raw.length / 1024)}KB — excede o limite de ${Math.round(MAX_MODEL_IMAGE_BYTES / 1024)}KB. O print foi salvo em disco se savePath foi informado.]`,
          })
        }
        return { type: 'content', value: parts }
      },
    }),
    show_image: tool({
      description:
        'Includes an image IN YOUR RESPONSE, visible to the user in the chat. Use fromPanel to attach a current screenshot of the panel browser, or path for an image in the working folder (e.g.: docs/login/screen.webp). The image appears at the point in the response where the tool was called — don\'t over-describe it afterward.',
      inputSchema: z.object({
        fromPanel: z.boolean().optional().describe('Captures the panel browser now and attaches it'),
        path: z
          .string()
          .optional()
          .describe('Relative path to an existing image in the working folder (png/jpg/webp/gif)'),
        alt: z.string().optional().describe('Short caption shown under the image'),
      }),
      execute: async ({ fromPanel, path: imagePath, alt }) => {
        let buffer: Buffer
        let ext: string
        if (fromPanel) {
          buffer = await panelScreenshot(ctx.sessionId)
          ext = 'webp'
        } else if (imagePath) {
          ext = path.extname(imagePath).slice(1).toLowerCase()
          if (!IMAGE_EXTENSIONS.has(ext)) {
            return `Extensão não suportada (${ext || 'sem extensão'}) — use png/jpg/webp/gif.`
          }
          buffer = await fsp.readFile(resolveSafePath(ctx, imagePath))
        } else {
          return 'Informe fromPanel ou path.'
        }
        const mediaUrl = await saveMedia(buffer, ext)
        return {
          mediaUrl,
          alt: alt ?? '',
          message: 'Imagem anexada à resposta — o usuário já a vê no chat.',
        }
      },
    }),
  }
}
