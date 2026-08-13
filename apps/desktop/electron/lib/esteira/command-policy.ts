import type { PoliticaComandos } from '@shared/esteira'

/**
 * Política de comandos em 3 camadas (§8 do plano). É o guarda-corpo que
 * substitui o pedido de permissão: a esteira roda sem supervisão, então o
 * irreversível é recusado e o que sai da máquina fica registrado na anotação.
 *
 * bloqueado → recusa (conta como falha da fase, o agente tem que contornar)
 * controlado → executa e registra
 * livre      → qualquer coisa fora das duas listas
 */

export type Camada = 'bloqueado' | 'controlado' | 'livre'

/** Normaliza para comparação: minúsculas, aspas fora, espaços colapsados. */
function normalizar(texto: string): string {
  return texto.toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * Um comando de shell pode encadear vários (`a && b`, `a; b`, `a | b`) — cada
 * segmento é classificado, e o resultado é o MAIS restritivo encontrado.
 * Sem isso, `npm test && git push --force` passaria como livre.
 */
function segmentos(comando: string): string[] {
  return comando
    .split(/(?:\|\||&&|;|\||\n)/)
    .map((s) => normalizar(s))
    .filter(Boolean)
}

function bate(segmento: string, padrao: string): boolean {
  const alvo = normalizar(padrao)
  // Prefixo cobre "git push --force origin main"; includes cobre os padrões
  // que aparecem no meio (ex.: "drop table" dentro de um -c "...").
  return segmento.startsWith(alvo) || segmento.includes(` ${alvo}`) || segmento.includes(alvo + ' ')
}

export interface Classificacao {
  camada: Camada
  /** Segmento que motivou a classificação (para a mensagem de recusa/registro) */
  motivo?: string
}

export function classificarComando(comando: string, politica: PoliticaComandos): Classificacao {
  let controlado: string | undefined
  for (const segmento of segmentos(comando)) {
    for (const padrao of politica.bloqueados) {
      if (bate(segmento, padrao)) return { camada: 'bloqueado', motivo: padrao }
    }
    if (!controlado) {
      for (const padrao of politica.controlados) {
        if (bate(segmento, padrao)) {
          controlado = padrao
          break
        }
      }
    }
  }
  return controlado ? { camada: 'controlado', motivo: controlado } : { camada: 'livre' }
}

/** Texto devolvido ao agente quando o comando é recusado. */
export function mensagemBloqueio(comando: string, motivo?: string): string {
  return [
    `Comando recusado pela política da esteira${motivo ? ` (regra: ${motivo})` : ''}: ${comando}`,
    'Este comando é irreversível ou perigoso demais para execução não supervisionada.',
    'Resolva a tarefa sem ele — se for realmente indispensável, registre isso na anotação da fase e encerre relatando a impossibilidade.',
  ].join('\n')
}
