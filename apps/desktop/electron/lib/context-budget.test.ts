import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'

import type { CatalogModel } from '@shared/chat'
import { contextBudget, estimateTokens, maxStepsFor, trimTurnContext } from './context-budget'

/**
 * Este corte é a única coisa entre o tool loop e um request que o provedor
 * recusa inteiro. Errar para menos deixa o turno estourar de novo (foi o bug
 * de origem: 3,4M tokens pedidos num modelo de 1M); errar para mais apaga a
 * mesa de trabalho do modelo no meio da tarefa, e ele relê tudo em loop.
 *
 * O par tool-call/tool-result também é frágil: provedores recusam com 400 um
 * histórico em que a chamada existe e o resultado sumiu, então o que este
 * módulo faz é ESVAZIAR o resultado, nunca removê-lo.
 */

const model = (context: number, output = 8_000): CatalogModel =>
  ({ id: 'm', name: 'M', limit: { context, output } }) as CatalogModel

/** Um par assistant(tool-call) + tool(tool-result), como o SDK monta. */
function toolPair(id: string, tool: string, input: unknown, output: string): ModelMessage[] {
  return [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: tool, input }] },
    {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: id, toolName: tool, output: { type: 'text', value: output } }],
    },
  ] as ModelMessage[]
}

const filler = (chars: number) => 'x'.repeat(chars)

function outputsOf(messages: ModelMessage[]): string[] {
  const values: string[] = []
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue
    for (const part of message.content) {
      const p = part as unknown as Record<string, unknown>
      if (p.type !== 'tool-result') continue
      const out = p.output as { value?: unknown }
      values.push(typeof out?.value === 'string' ? out.value : '')
    }
  }
  return values
}

describe('estimateTokens', () => {
  it('cobra anexo binário por tamanho fixo, não por caractere de base64', () => {
    // Um PNG de 1MB vira ~250k caracteres de base64 e ~1.5k tokens no
    // provedor. Contá-lo por caractere faria o orçamento achar que estourou e
    // descartar meio turno num turno que cabia folgado.
    const comImagem: ModelMessage[] = [
      { role: 'user', content: [{ type: 'file', data: filler(250_000), mediaType: 'image/png' }] },
    ] as ModelMessage[]
    expect(estimateTokens(comImagem)).toBeLessThan(5_000)
  })

  it('conta texto na ordem de grandeza certa', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: filler(40_000) }]
    expect(estimateTokens(messages)).toBe(10_000)
  })
})

describe('maxStepsFor', () => {
  it('escala pelo contexto, dentro do piso e do teto', () => {
    expect(maxStepsFor(model(200_000))).toBe(120)
    expect(maxStepsFor(model(1_048_576))).toBe(300)
    expect(maxStepsFor(model(400_000))).toBeGreaterThanOrEqual(117)
  })

  it('usa o piso quando o catálogo não anuncia contexto', () => {
    expect(maxStepsFor(undefined)).toBe(120)
    expect(maxStepsFor({ id: 'm', name: 'M' } as CatalogModel)).toBe(120)
  })
})

describe('contextBudget', () => {
  it('respeita o teto absoluto em modelos de janela gigante', () => {
    // Sem o teto, um modelo de 1M só cortaria perto de 1M — a conversa
    // operaria rotineiramente com centenas de milhares de tokens por step.
    expect(contextBudget(model(1_048_576, 128_000))).toBeLessThanOrEqual(300_000)
  })

  it('desconta a saída e o system prompt da janela do modelo', () => {
    expect(contextBudget(model(200_000, 8_000))).toBe(162_000)
  })
})

describe('trimTurnContext', () => {
  it('devolve a MESMA referência quando cabe no orçamento', () => {
    // O prepareStep responde `{}` nesse caso e o SDK pula a reescrita das
    // mensagens — comparar por referência é o que sinaliza isso.
    const messages = [...toolPair('a', 'read', { filePath: 'a.ts' }, filler(200))]
    expect(trimTurnContext(messages, 100_000)).toBe(messages)
  })

  it('esvazia o resultado mais antigo, preservando a tool call', () => {
    const messages = [
      ...toolPair('1', 'bash', { command: 'npm test' }, filler(120_000)),
      ...toolPair('2', 'bash', { command: 'npm run lint' }, filler(120_000)),
      ...toolPair('3', 'bash', { command: 'git status' }, filler(120_000)),
    ]
    const trimmed = trimTurnContext(messages, 65_000)

    // Nenhuma mensagem some: quebrar o par call/result derruba o turno com 400.
    expect(trimmed).toHaveLength(messages.length)
    const calls = trimmed.filter((m) => m.role === 'assistant')
    expect(calls).toHaveLength(3)
    // O mais antigo virou o aviso; o mais recente continua intacto.
    const outputs = outputsOf(trimmed)
    expect(outputs[0]).toContain('tool output dropped')
    expect(outputs[2]).toBe(filler(120_000))
  })

  it('descarta chamada repetida com os mesmos argumentos, mantendo a última', () => {
    // `read` do mesmo arquivo três vezes num turno é de longe o caso mais
    // comum — nos dados reais o `read` sozinho era metade do payload de tools.
    const messages = [
      ...toolPair('1', 'read', { filePath: 'src/app.ts' }, filler(60_000)),
      ...toolPair('2', 'bash', { command: 'npm test' }, filler(60_000)),
      ...toolPair('3', 'read', { filePath: 'src/app.ts' }, filler(60_000)),
    ]
    const outputs = outputsOf(trimTurnContext(messages, 30_000))

    expect(outputs[0]).toContain('repeated later in the turn')
    expect(outputs[2]).toBe(filler(60_000))
  })

  it('não mexe em chamadas repetidas de ferramenta com efeito colateral', () => {
    // O segundo `git status` não invalida o primeiro como registro do que
    // aconteceu no turno — e `write`/`edit` mudam o disco entre as chamadas.
    const messages = [
      ...toolPair('1', 'bash', { command: 'git status' }, filler(40_000)),
      ...toolPair('2', 'bash', { command: 'git status' }, filler(40_000)),
    ]
    expect(trimTurnContext(messages, 60_000)).toBe(messages)
  })

  it('preserva a mesa de trabalho enquanto o corte por idade resolve', () => {
    // Descartar o que o modelo acabou de ler faria ele reler em loop e nunca
    // convergir — queima tokens sem avançar.
    const messages = Array.from({ length: 14 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `cmd ${i}` }, filler(40_000)),
    ).flat()
    // Orçamento em que o corte por idade sozinho já resolve: os 10 últimos
    // (KEEP_RECENT_RESULTS) nunca chegam a ser tocados.
    const outputs = outputsOf(trimTurnContext(messages, 105_000))

    expect(outputs.slice(-10).every((o) => o === filler(40_000))).toBe(true)
    expect(outputs.some((o) => o.includes('tool output dropped'))).toBe(true)
  })

  it('no pior caso avança sobre os recentes, parando nos dois últimos quando eles cabem', () => {
    // Poucas saídas gigantes sozinhas já passam do orçamento. Aqui o corte por
    // idade não tem o que descartar, e parar por aí devolveria ao provedor o
    // mesmo request que ele recusa — o defeito de origem.
    const messages = Array.from({ length: 6 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `cmd ${i}` }, filler(80_000)),
    ).flat()
    const outputs = outputsOf(trimTurnContext(messages, 45_000))

    expect(outputs.slice(0, 4).every((o) => o.includes('tool output dropped'))).toBe(true)
    expect(outputs.slice(-2).every((o) => o === filler(80_000))).toBe(true)
  })

  it('descarta até um resultado recente quando ele sozinho não cabe', () => {
    // O caso real: um screenshot MCP serializado como 3,3M caracteres de
    // base64 era o ÚLTIMO resultado do turno. O piso dos dois recentes o
    // protegia e o request saía com 917k tokens num modelo de 1M.
    const messages = [
      ...toolPair('a', 'read', { filePath: 'src/app.ts' }, filler(4_000)),
      ...toolPair('b', 'Nodara_adb_screenshot', {}, filler(3_300_000)),
    ]
    const budget = 200_000
    const trimmed = trimTurnContext(messages, budget)
    const outputs = outputsOf(trimmed)

    expect(outputs[0]).toBe(filler(4_000))
    expect(outputs[1]).toContain('too large to fit')
    expect(estimateTokens(trimmed)).toBeLessThanOrEqual(budget)
  })

  it('segura o turno que originou o bug: 1M de janela, o teto de passos inteiro', () => {
    // Reconstrução do caso real (mimo-v2-pro no Console Go, janela de
    // 1.048.576): o turno pediu 3.463.912 tokens e o provedor recusou a
    // requisição inteira. Mistura medida nas sessões do usuário — `bash` no
    // teto de 30k chars, `read` na média de 4.4k, e releitura dos mesmos
    // arquivos, que sozinha era metade do payload de ferramentas.
    const catalog = model(1_048_576, 128_000)
    const budget = contextBudget(catalog)
    const files = ['src/app.ts', 'src/engine.ts', 'src/ui.tsx', 'src/store.ts']

    const messages = Array.from({ length: maxStepsFor(catalog) }, (_, i) => {
      // Médias reais por ferramenta, medidas nas sessões: bash no teto de 30k
      // chars, websearch ~15k, read ~4.4k.
      if (i % 3 === 0) return toolPair(String(i), 'bash', { command: `npm run task-${i}` }, filler(30_000))
      if (i % 3 === 1) return toolPair(String(i), 'websearch', { query: `q${i}` }, filler(15_000))
      return toolPair(String(i), 'read', { filePath: files[i % files.length] }, filler(4_400))
    }).flat()

    expect(estimateTokens(messages)).toBeGreaterThan(1_048_576)
    expect(estimateTokens(trimTurnContext(messages, budget))).toBeLessThanOrEqual(budget)
  })

  it('encurta o input da chamada cujo resultado foi descartado', () => {
    // O `content` de um `write` grande fica no contexto para sempre; depois de
    // descartado o resultado, ele não serve mais para nada.
    const messages = [
      ...toolPair('1', 'write', { filePath: 'a.ts', content: filler(200_000) }, 'ok'),
      ...toolPair('2', 'bash', { command: 'npm test' }, filler(4_000)),
      ...toolPair('3', 'bash', { command: 'npm run lint' }, filler(4_000)),
    ]
    const trimmed = trimTurnContext(messages, 5_000)
    const call = (trimmed[0].content as unknown as Array<Record<string, unknown>>)[0]
    const input = call.input as { filePath: string; content: string }

    // As chaves ficam: o provedor valida o input contra o schema da ferramenta.
    expect(input.filePath).toBe('a.ts')
    expect(input.content.length).toBeLessThan(600)
    expect(input.content).toContain('chars dropped')
  })

  it('é idempotente — o que já foi cortado não é reprocessado a cada step', () => {
    const messages = Array.from({ length: 4 }, (_, i) =>
      toolPair(String(i), 'bash', { command: `cmd ${i}` }, filler(90_000)),
    ).flat()
    const first = trimTurnContext(messages, 20_000)
    expect(first).not.toBe(messages)
    // Segunda passada sobre o resultado: nada novo a descartar, mesma
    // referência de volta. Sem isso o prepareStep reescreveria as mensagens em
    // todo step do turno.
    expect(trimTurnContext(first, 20_000)).toBe(first)
  })
})
