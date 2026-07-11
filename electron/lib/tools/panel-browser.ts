import { tool, type ToolSet } from 'ai'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { saveMedia } from '../media'
import {
  panelClick,
  panelNavigate,
  panelRead,
  panelScreenshot,
  panelType,
} from '../panel-browser'
import { resolveSafePath, type ToolContext } from './context'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])

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
    panel_screenshot: tool({
      description:
        'Tira um screenshot da página do painel e o VÊ como imagem. Com savePath, também salva o PNG na pasta de trabalho (ex: docs/login/tela.png) — use no modo documentação.',
      inputSchema: z.object({
        savePath: z
          .string()
          .optional()
          .describe('Caminho relativo à pasta de trabalho para salvar o PNG (opcional)'),
      }),
      execute: async ({ savePath }, { toolCallId }) => {
        const png = await panelScreenshot()
        screenshotStash.set(toolCallId, png.toString('base64'))
        let saved = ''
        if (savePath) {
          const target = resolveSafePath(ctx, savePath)
          await fsp.mkdir(path.dirname(target), { recursive: true })
          await fsp.writeFile(target, png)
          saved = ` Salvo em ${savePath}.`
        }
        return `Screenshot capturado (${Math.round(png.length / 1024)}KB).${saved}`
      },
      toModelOutput: ({ toolCallId, output }) => {
        const base64 = screenshotStash.get(toolCallId)
        screenshotStash.delete(toolCallId)
        if (!base64) return { type: 'text', value: String(output) }
        return {
          type: 'content',
          value: [
            { type: 'text', text: String(output) },
            { type: 'file', data: { type: 'data', data: base64 }, mediaType: 'image/png' },
          ],
        }
      },
    }),
    show_image: tool({
      description:
        'Inclui uma imagem NA SUA RESPOSTA, visível para o usuário no chat. Use fromPanel para anexar um print atual do browser do painel, ou path para uma imagem da pasta de trabalho (ex: docs/login/tela.png). A imagem aparece no ponto da resposta em que a tool foi chamada — não a descreva em excesso depois.',
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
        let ext = 'png'
        if (fromPanel) {
          buffer = await panelScreenshot()
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
