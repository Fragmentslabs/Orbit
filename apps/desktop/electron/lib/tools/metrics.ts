import fsp from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage'
import type { FamiliaFerramenta } from './catalogo'

/**
 * Telemetria de desfecho do toolset.
 *
 * Grava UMA linha JSON por turno em `orbit-data/tool-metrics.jsonl` — append,
 * nunca reescrita. O objetivo é responder, sem instrumentar o modelo, as duas
 * perguntas que decidem se o toolset funcionou:
 *
 * 1. **Família oferecida e nunca chamada**: custo de contexto pago à toa.
 * 2. **Tool chamada e que falhou**: a família está certa, a tool não.
 *
 * Por que no início do turno e não no fim: o engine não expõe `onFinish`, e
 * instrumentar o stream para saber o desfecho custaria mais do que o dado vale.
 * Do histórico já dá para ler o que foi chamado e o que falhou — o que não se
 * consegue é separar por turno exato, e para decidir família isso não muda nada.
 */

export interface TurnMetrics {
  at: string
  /** Tools declaradas no request (o que o modelo viu). */
  offered: number
  /** Famílias com tools vivas. */
  families: number
  /** Famílias fora do ar, com o motivo — não foram oferecidas. */
  disabled: string[]
  /** Quantas tools_load o histórico retido pediu. */
  loads: number
  /** Tools efetivamente chamadas no histórico retido. */
  calls: string[]
  /** Resultados de tool marcados como erro. */
  failed: number
  /** Famílias cujas tools estão em `calls`. */
  usedFamilies: string[]
}

/** Lê do histórico o que já foi chamado. `messages` é o array do turno. */
export function usageFromHistory(mensagens: readonly unknown[]): Pick<TurnMetrics, 'loads' | 'calls' | 'failed'> {
  const calls = new Set<string>()
  let failed = 0
  let loads = 0
  for (const mensagem of mensagens) {
    // O histórico vem do disco e pode trazer item nulo: sem esta guarda a
    // leitura inteira lançaria, e a telemetria perderia o turno por causa de
    // uma linha corrompida.
    if (!mensagem || typeof mensagem !== 'object') continue
    const conteudo = (mensagem as { content?: unknown }).content
    if (!Array.isArray(conteudo)) continue
    for (const parte of conteudo) {
      if (!parte || typeof parte !== 'object') continue
      const p = parte as Record<string, unknown>
      if (p.type === 'tool-call' && typeof p.toolName === 'string') {
        calls.add(p.toolName)
        if (p.toolName === 'tools_load') loads++
      }
      if (p.type === 'tool-result' && p.isError === true) failed++
    }
  }
  return { loads, calls: [...calls].sort(), failed }
}

/**
 * Registra o turno. Nunca lança: telemetria que derruba o chat é pior do que
 * telemetria ausente, então erro de disco vira linha no console e segue.
 */
export async function recordTurn(input: {
  familias: readonly FamiliaFerramenta[]
  offered: number
  mensagens: readonly unknown[]
}): Promise<void> {
  try {
    const uso = usageFromHistory(input.mensagens)
    const usadas = new Set(uso.calls)
    const metrics: TurnMetrics = {
      at: new Date().toISOString(),
      offered: input.offered,
      families: input.familias.filter((f) => !f.indisponivel && f.tools.length > 0).length,
      disabled: input.familias.filter((f) => f.indisponivel).map((f) => f.id),
      ...uso,
      usedFamilies: input.familias
        .filter((f) => f.tools.some((nome) => usadas.has(nome)))
        .map((f) => f.id),
    }
    await fsp.appendFile(path.join(dataDir(), 'tool-metrics.jsonl'), `${JSON.stringify(metrics)}\n`, 'utf8')
  } catch (err) {
    console.warn('[toolset] failed to append metrics:', err)
  }
}
