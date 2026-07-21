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
        'Abre uma URL no browser do painel direito do Orbit (o painel abre sozinho). Use para testar aplicações web — servidores locais (http://localhost:...) incluídos.',
      inputSchema: z.object({
        url: z.string().describe('URL completa (http/https)'),
      }),
      execute: async ({ url }) => {
        const result = await panelNavigate(url)
        return `Carregado: ${result.title || '(sem título)'} — ${result.url}. Use panel_read para ver o conteúdo ou panel_screenshot para ver a tela.`
      },
    }),
    panel_read: tool({
      description:
        'Lê a página aberta no browser do painel: título, URL, texto visível e elementos interativos com refs numeradas para panel_click/panel_type.',
      inputSchema: z.object({}),
      execute: async () => panelRead(),
    }),
    panel_click: tool({
      description:
        'Clica em um elemento da página do painel, por ref (do panel_read) ou seletor CSS. Refs mudam após navegação — rode panel_read de novo.',
      inputSchema: z.object({
        ref: z.number().int().optional().describe('Ref numérica do panel_read'),
        selector: z.string().optional().describe('Seletor CSS (alternativa à ref)'),
      }),
      execute: async ({ ref, selector }) => {
        if (ref == null && !selector) return 'Informe ref ou selector.'
        return panelClick(ref, selector)
      },
    }),
    panel_type: tool({
      description:
        'Digita texto em um campo da página do painel (por ref ou seletor CSS), com opção de enviar o formulário.',
      inputSchema: z.object({
        text: z.string().describe('Texto a digitar'),
        ref: z.number().int().optional().describe('Ref numérica do panel_read'),
        selector: z.string().optional().describe('Seletor CSS (alternativa à ref)'),
        pressEnter: z.boolean().optional().describe('Envia o formulário após digitar'),
      }),
      execute: async ({ text, ref, selector, pressEnter }) => {
        if (ref == null && !selector) return 'Informe ref ou selector.'
        return panelType(text, ref, selector, pressEnter)
      },
    }),
    panel_resize: tool({
      description:
        'Redimensiona o viewport do browser do painel para testar responsividade. Use um preset (mobile/tablet/desktop/fit) ou width/height custom. Depois use panel_screenshot para ver o resultado.',
      inputSchema: z.object({
        preset: z.enum(['mobile', 'tablet', 'desktop', 'fit']).optional(),
        width: z.number().int().min(280).max(3840).optional().describe('Largura custom em px'),
        height: z.number().int().min(400).max(2160).optional().describe('Altura custom em px'),
      }),
      execute: async ({ preset, width, height }) => {
        if (width && height) return panelResize(width, height, `${width}×${height}`)
        const chosen = VIEWPORT_PRESETS[preset ?? 'fit']
        return panelResize(chosen.width, chosen.height, chosen.label)
      },
    }),
    panel_screenshot: tool({
      description:
        'Tira um screenshot da página do painel e o VÊ como imagem. Com savePath, também salva o WebP na pasta de trabalho (ex: docs/login/tela.webp) — use no modo documentação. Com fullscreen, expande para tela cheia, captura a tela toda e volta à visão lateral.',
      inputSchema: z.object({
        savePath: z
          .string()
          .optional()
          .describe('Caminho relativo à pasta de trabalho para salvar o WebP (opcional)'),
        fullscreen: z
          .boolean()
          .optional()
          .describe('Captura em tela cheia (print maior) e retorna à visão lateral'),
      }) as any,
      execute: async ({ savePath, fullscreen }, { toolCallId }) => {
        const webp = await panelScreenshot(fullscreen === true)
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
        'Inclui uma imagem NA SUA RESPOSTA, visível para o usuário no chat. Use fromPanel para anexar um print atual do browser do painel, ou path para uma imagem da pasta de trabalho (ex: docs/login/tela.webp). A imagem aparece no ponto da resposta em que a tool foi chamada — não a descreva em excesso depois.',
      inputSchema: z.object({
        fromPanel: z.boolean().optional().describe('Captura o browser do painel agora e anexa'),
        path: z
          .string()
          .optional()
          .describe('Caminho relativo de uma imagem existente na pasta de trabalho (png/jpg/webp/gif)'),
        alt: z.string().optional().describe('Legenda curta exibida sob a imagem'),
      }),
      execute: async ({ fromPanel, path: imagePath, alt }) => {
        let buffer: Buffer
        let ext: string
        if (fromPanel) {
          buffer = await panelScreenshot()
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
