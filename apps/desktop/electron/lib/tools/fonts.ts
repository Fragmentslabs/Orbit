import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { fontFaceCss, listFonts, type OrbitFont } from '../fonts/store'
import { catalog, ensureFont, searchCatalog } from '../fonts/source'

/**
 * Fontes externas: buscar no catálogo aberto (Fontsource) e INSTALAR na
 * biblioteca do Orbit.
 *
 * Instalar aqui não pede permissão e não escreve nada no computador: o arquivo
 * fica em `orbit-data/fonts` e o scheme `orbit-font://` o entrega ao artboard,
 * à composição de motion e à própria janela do app. É o equivalente a "usar uma
 * fonte" num app de design — o `font-family` pelo NOME passa a renderizar.
 *
 * Nada é copiado para o projeto do usuário: o design referencia a família como
 * qualquer fonte do sistema, e a composição de motion recebe só o bloco
 * `@font-face` (a URL do scheme é local e imutável).
 */

function line(font: OrbitFont): string {
  const kind = font.variable ? `variable ${font.weights[0] ?? ''}`.trim() : `static ${font.weights.join('/')}`
  const license = font.license?.type ? ` · ${font.license.type}` : ''
  const subsets = font.subsets.join(', ')
  return `${font.family} (id: ${font.id}) — ${kind}${license} · subsets: ${subsets}`
}

/** O bloco pronto para colar numa composição de motion. */
function motionBlock(font: OrbitFont): string {
  return `<style>\n${fontFaceCss([font])}\n</style>`
}

export function createFontTools(): ToolSet {
  return {
    font_search: tool({
      description:
        'Searches the open font catalog (Fontsource: ~2,000 families, Google Fonts and other OFL/Apache-licensed work) by name. Returns the id, category, license, weights and subsets of each match — it does NOT download anything. ' +
        'Use it when the user wants a typeface that is not the system default ("use Inter", "a geometric sans", "JetBrains Mono"). Then call font_use with the family you picked.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Family name or part of it (e.g. "inter", "playfair", "mono")'),
        limit: z.number().int().min(1).max(20).optional().describe('How many results (default 8)'),
      }),
      execute: async ({ query, limit }) => {
        const fonts = await catalog()
        const found = searchCatalog(fonts, query, limit ?? 8)
        if (found.length === 0) return `No font in the catalog matches "${query}". Try a shorter or different word.`
        return found
          .map(
            (font) =>
              `${font.family} (id: ${font.id}) — ${font.category ?? 'unknown'} · ${font.variable ? 'variable' : `static ${font.weights.join('/')}`} · ${font.license ?? 'license not declared'} · subsets: ${font.subsets.join(', ')}`,
          )
          .join('\n')
      },
    }),

    font_use: tool({
      description:
        'Installs a font from the catalog into the Orbit font library (downloads the woff2 files, once — reusing it later costs nothing) and returns everything needed to use it. No permission is required: nothing is written to the user\'s project or installed in the operating system. ' +
        'After this, the family is available BY NAME:\n' +
        '• DESIGN: just set `font-family: \'<Family>\'` in the artboard CSS — the Design tab declares every installed font automatically, so do NOT paste @font-face into the artboard.\n' +
        '• MOTION: paste the returned <style> block (it points at the local orbit-font:// file) into the composition; never use a remote font URL.\n' +
        'The family also appears in the font picker of the Design inspector. Prefer a variable font (one file covers 100–900) when you need several weights.',
      inputSchema: z.object({
        family: z.string().min(1).describe('Family name or catalog id (e.g. "Inter", "inter", "jetbrains-mono")'),
        subsets: z
          .array(z.string())
          .optional()
          .describe('Subsets to download (default: latin + latin-ext, which covers Portuguese). Only widen it for Cyrillic, Greek, Vietnamese etc.'),
        styles: z.array(z.enum(['normal', 'italic'])).optional().describe('Styles to download (default: normal only)'),
      }),
      execute: async ({ family, subsets, styles }) => {
        const font = await ensureFont(family, { subsets, styles })
        const license = font.license
          ? `${font.license.type}${font.license.url ? ` — ${font.license.url}` : ''}${font.license.attribution ? `\nAttribution: ${font.license.attribution}` : ''}`
          : 'not declared by the package'
        return [
          `"${font.family}" is installed in the Orbit font library.`,
          `id: ${font.id} · ${font.variable ? 'variable' : 'static'} · weights: ${font.weights.join(', ')} · subsets: ${font.subsets.join(', ')}`,
          `License: ${license}`,
          '',
          'DESIGN — use it by name, no @font-face needed (the Design tab declares the library for every artboard):',
          `  font-family: '${font.family}';`,
          '',
          'MOTION — paste this into the composition (local file, renders offline):',
          motionBlock(font),
          '',
          `It also shows up in the font picker of the Design inspector (Typography → font family).`,
        ].join('\n')
      },
    }),

    font_list: tool({
      description:
        'Lists the fonts already installed in the Orbit library (family, id, weights, subsets, license). Check this before downloading something again, and to tell the user which fonts are available.',
      inputSchema: z.object({}),
      execute: async () => {
        const fonts = await listFonts()
        if (fonts.length === 0) return 'The Orbit font library is empty. Use font_search + font_use to install a family.'
        return `${fonts.length} font${fonts.length === 1 ? '' : 's'} in the Orbit library:\n${fonts.map(line).join('\n')}`
      },
    }),
  }
}
