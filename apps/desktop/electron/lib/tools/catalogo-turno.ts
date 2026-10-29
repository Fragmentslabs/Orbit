import type { BrowserWindow } from 'electron'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ToolSet } from 'ai'
import { limiteDeTools, type SendMessageInput } from '@shared/chat'
import { buildToolSet, type ImageToolHooks, type ToolContext } from './index'
import {
  CHARS_POR_TOKEN,
  aplicarFreio,
  classificarFamilias,
  tokensDoSchema,
  type FamiliaFerramenta,
} from './catalogo'
import { createToolBridgeTools } from './carregar'
import { listMcpServerPrefixes, listUnavailableMcpServers } from '../mcp'

/**
 * Monta o ToolSet do turno **e** as famílias do catálogo — o insumo do funil
 * de tools sob demanda.
 *
 * Fica separado de `buildToolSet` de propósito: os workers continuam chamando
 * `buildToolSet` direto e recebem o conjunto estático (§6.7 do plano — worker é
 * curto e estreito, um round-trip nele custa proporcionalmente mais). Só o
 * turno normal e o orquestrador passam por aqui.
 */
export function construirCatalogo(
  input: SendMessageInput,
  ctx: ToolContext | null,
  imageHooks?: ImageToolHooks,
  modelVision?: boolean,
  win?: BrowserWindow,
): { tools: ToolSet; familias: FamiliaFerramenta[] } {
  const tools = buildToolSet(input, ctx, imageHooks, modelVision, win)
  // Servidores MCP viram família pelo prefixo sanitizado com que o manager
  // nomeia as tools (`<servidor>_<tool>`) — derivado, nunca declarado.
  const familias = classificarFamilias(
    tools,
    input,
    listMcpServerPrefixes(),
    listUnavailableMcpServers(),
  )
  // As pontes entram DEPOIS da classificação: elas são núcleo, não família.
  if (input.orchestrationRole !== 'worker') {
    Object.assign(tools, createToolBridgeTools({ familias, tools }))
  }
  // Freio de mão DEPOIS das pontes: tools_load/tools_list são núcleo e precisam
  // sobreviver ao corte, senão o teto do provedor vira turno morto.
  aplicarFreio(tools, familias, limiteDeTools(input.providerId))
  // A telemetria do turno fica no engine, onde oferta e histórico estão no
  // mesmo ponto. Aqui não há mensagens: um registro sem uso responderia metade.
  if (process.env.ORBIT_DEBUG_TOOLSET === '1') dumpToolset(input, tools, familias)
  return { tools, familias }
}

/**
 * Tarefa 0 do plano, versão de campo: com `ORBIT_DEBUG_TOOLSET=1`, grava em
 * orbit-data/toolset-debug.json quantas tools e quantos tokens de schema cada
 * família custa NESTE turno, e a linha total no console. É o número que calibra
 * o mapa e o cap do §6.4 — sem ele, qualquer teto é chute.
 *
 * `tokensDoSchema` usa chars/4 de propósito (subestima um pouco: menos ativação
 * falsa, mais folga no orçamento).
 */
function dumpToolset(
  input: SendMessageInput,
  tools: ToolSet,
  familias: FamiliaFerramenta[],
): void {
  try {
    const familiaDe = new Map<string, string>()
    for (const familia of familias) {
      for (const nome of familia.tools) familiaDe.set(nome, familia.id)
    }
    const itens = Object.entries(tools)
      .map(([nome, ferramenta]) => ({
        nome,
        familia: familiaDe.get(nome) ?? 'nucleo',
        tokens: tokensDoSchema(ferramenta),
      }))
      .sort((a, b) => b.tokens - a.tokens)
    const total = itens.reduce((soma, item) => soma + item.tokens, 0)

    const porFamilia = new Map<string, { tools: number; tokens: number }>()
    for (const item of itens) {
      const atual = porFamilia.get(item.familia) ?? { tools: 0, tokens: 0 }
      porFamilia.set(item.familia, {
        tools: atual.tools + 1,
        tokens: atual.tokens + item.tokens,
      })
    }

    const arquivo = path.join(app.getPath('userData'), 'orbit-data', 'toolset-debug.json')
    fs.mkdirSync(path.dirname(arquivo), { recursive: true })
    fs.writeFileSync(
      arquivo,
      JSON.stringify(
        {
          em: new Date().toISOString(),
          modo: input.mode,
          provider: input.providerId,
          tools: itens.length,
          tokens: total,
          charsPorToken: CHARS_POR_TOKEN,
          porFamilia: [...porFamilia.entries()]
            .map(([id, valores]) => ({ id, ...valores }))
            .sort((a, b) => b.tokens - a.tokens),
          itens,
        },
        null,
        2,
      ),
    )
    console.log(`[tools] ${input.mode}: ${itens.length} tools, ~${total} tokens de schema → ${arquivo}`)
  } catch (erro) {
    console.warn('[tools] dump do toolset falhou:', erro)
  }
}
