import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { buscar } from './busca'
import type { FamiliaFerramenta } from './catalogo'
import { estimarTokens } from './catalogo'

/**
 * As duas pontes do funil: `tools_load` e `tools_list`.
 *
 * Elas não guardam estado. "Carregar" só significa devolver o manual e a
 * confirmação; quem ativa a família é a derivação do histórico (`ativas.ts`),
 * que vê esta mesma chamada no passo seguinte. Isso é o que torna o mecanismo
 * imune a retry, rotação de provider e compactação.
 */

/** Servidor acima disto não carrega inteiro: usa busca. */
export const MAX_TOOLS_POR_FAMILIA = 40

export interface PonteContexto {
  familias: readonly FamiliaFerramenta[]
  /** ToolSet real — é dele que saem as descrições para a busca. */
  tools: ToolSet
}

function descricaoDe(tools: ToolSet, nome: string): string {
  const def = tools[nome] as { description?: string } | undefined
  const bruta = def?.description ?? ''
  // Descrição de MCP de terceiro é TEXTO NÃO CONFIÁVEL: uma linha só, sem
  // marcadores de instrução, cortada. O corte é marcado — nunca em silêncio.
  const limpa = bruta
    .replace(/[\r\n]+/g, ' ')
    .replace(/[`<>#]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!limpa) return ''
  return limpa.length > 200 ? `${limpa.slice(0, 200)}… (descrição completa ao carregar)` : limpa
}

function rotulo(familia: FamiliaFerramenta): string {
  return familia.mcp ? `@mcp:${familia.id.replace(/^mcp:/, '')}` : familia.id
}

function acharFamilia(
  familias: readonly FamiliaFerramenta[],
  entrada: { family?: string; server?: string },
): FamiliaFerramenta | undefined {
  if (entrada.family) return familias.find((f) => f.id === entrada.family)
  if (entrada.server) return familias.find((f) => f.id === `mcp:${entrada.server}`)
  return undefined
}

export function createToolBridgeTools(ctx: PonteContexto) {
  const ids = ctx.familias.map(rotulo).join(', ')

  const tools_load = tool({
    description:
      'Loads a family of tools into this step. The system prompt lists the families, what each one does, and which ones are disabled here. Call this when the work needs a tool that is not loaded yet; then call the real tool in the next step. Without arguments it returns the catalog. With `server` + `query` it searches inside a large MCP server instead of loading it whole. Do not use it to call a tool — it only loads.',
    inputSchema: z.object({
      family: z.string().optional().describe('Family id from the catalog (e.g. "documents", "video", "design").'),
      server: z.string().optional().describe('MCP server name, without the @mcp: prefix.'),
      tools: z.array(z.string()).optional().describe('Exact tool names to load, when you already know them.'),
      query: z.string().optional().describe('Words describing what you need — searches inside a large family.'),
    }),
    execute: async ({ family, server, tools: nomes, query }) => {
      // Sem argumento: devolve o catálogo inteiro (é o "não sei o que existe").
      if (!family && !server && !nomes?.length && !query) {
        return `Famílias disponíveis neste turno:\n${ctx.familias
          .map((f) =>
            f.indisponivel
              ? `- ${rotulo(f)} — DESATIVADA: ${f.indisponivel}`
              : `- ${rotulo(f)} — ${f.tools.length} tools: ${f.descricao}`,
          )
          .join('\n')}`
      }

      // Nomes explícitos: valida contra o catálogo em vez de aceitar em silêncio.
      if (nomes?.length) {
        const existentes = new Set(ctx.familias.flatMap((f) => f.tools))
        const desconhecidos = nomes.filter((n) => !existentes.has(n))
        if (desconhecidos.length > 0) {
          const sugestoes = buscar(
            ctx.familias.flatMap((f) => f.tools.map((nome) => ({ nome, texto: `${nome} ${descricaoDe(ctx.tools, nome)}` }))),
            desconhecidos,
            5,
          )
          return `Estas tools não existem neste turno: ${desconhecidos.join(', ')}.${
            sugestoes.length ? ` Parecidas: ${sugestoes.map((s) => s.nome).join(', ')}.` : ''
          }\nFamílias: ${ids}`
        }
        return `Carregado: ${nomes.join(', ')}. Chame a tool agora.`
      }

      const familia = acharFamilia(ctx.familias, { family, server })
      // Família desativada: dizer o MOTIVO é o ponto — não é para o modelo
      // descobrir chamando a tool e tomando um erro.
      if (familia?.indisponivel) {
        return `${rotulo(familia)} está DESATIVADA neste turno: ${familia.indisponivel}. Não insista: explique ao usuário ou use outra família.`
      }
      if (familia) {
        // Servidor grande: não carrega inteiro nem com query vazia.
        if (familia.tools.length > MAX_TOOLS_POR_FAMILIA && !query) {
          return `${rotulo(familia)} tem ${familia.tools.length} tools — grande demais para carregar por inteiro. Use tools_load({ server: "${rotulo(familia).replace(/^@mcp:/, '')}", query: "<o que você precisa>" }).`
        }
        if (query) {
          const achadas = buscar(
            familia.tools.map((nome) => ({ nome, texto: `${nome} ${descricaoDe(ctx.tools, nome)}` })),
            [query],
            Math.min(MAX_TOOLS_POR_FAMILIA, 8),
          )
          if (achadas.length === 0) {
            return `Nada em ${rotulo(familia)} casou com "${query}". Nomes disponíveis:\n${familia.tools.join('\n')}`
          }
          return `${rotulo(familia)} — ${achadas.map((a) => a.nome).join(', ')} (carregadas). Chame a tool agora.${
            familia.manual ? `\n\n${familia.manual}` : ''
          }`
        }
        return `${rotulo(familia)} ATIVA — ${familia.tools.length} tools: ${familia.tools.join(', ')}. Chame a tool agora.${
          familia.manual ? `\n\n${familia.manual}` : ''
        }`
      }

      // Família desconhecida: devolve o catálogo em vez de "não encontrado".
      return `Família "${family ?? server}" não existe neste turno. Disponíveis: ${ids}`
    },
  })

  const tools_list = tool({
    description:
      'Lists the tools of a family (or server) with one line each, without loading them. Use it when you do not know the tool name and the catalog only showed a count.',
    inputSchema: z.object({
      family: z.string().optional().describe('Family id. Omit to list every family.'),
      server: z.string().optional().describe('MCP server name.'),
    }),
    execute: async ({ family, server }) => {
      const alvo = family || server ? acharFamilia(ctx.familias, { family, server }) : undefined
      if (!alvo) {
        return ctx.familias
          .map((f) => `${rotulo(f)} — ${f.tools.length} tools`)
          .join('\n')
      }
      if (alvo.indisponivel) return `${rotulo(alvo)} está DESATIVADA: ${alvo.indisponivel}.`
      return alvo.tools
        .slice(0, 120)
        .map((nome) => `- ${nome}: ${descricaoDe(ctx.tools, nome) || 'sem descrição'}`)
        .join('\n')
    },
  })

  return { tools_load, tools_list }
}

/** Tokens do manual que viaja no `tools_load` — telemetria da Fase 3. */
export function tokensDoManual(familia: FamiliaFerramenta): number {
  return familia.manual ? estimarTokens(familia.manual) : 0
}
