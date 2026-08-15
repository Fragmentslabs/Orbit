import type { TFunction } from 'i18next'
import type { Agenda } from '@orbit/shared'
import { parseHorario } from '@orbit/shared'

/** Helpers puros da agenda das rotinas — espelho do agenda.ts do desktop. */

export type ModoAgenda = 'diario' | 'semanal' | 'intervalo'

export function modoDaAgenda(agenda: Agenda): ModoAgenda {
  if (agenda.intervaloDias && agenda.intervaloDias > 1) return 'intervalo'
  if (agenda.dias?.length) return 'semanal'
  return 'diario'
}

/** Iniciais dos dias para os botões de alternar (D S T Q Q S S). */
export function diasCurtos(t: TFunction): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => t(`rotinas.agenda.dia.${d}`))
}

/** Abreviações de 3 letras (Seg, Ter…) — as iniciais viram "S, T, Q, Q, S"
 *  numa frase, que ninguém consegue ler. */
function diasAbreviados(t: TFunction): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => t(`rotinas.agenda.diaAbrev.${d}`))
}

const UTEIS = '1,2,3,4,5'
const FIM_DE_SEMANA = '0,6'

/** Frase do cartão: "Todo dia às 09:00", "Seg, Qua, Sex às 18:30"… */
export function descreverAgenda(agenda: Agenda, t: TFunction): string {
  const horario = parseHorario(agenda.horario) ? agenda.horario : '??:??'
  if (agenda.intervaloDias && agenda.intervaloDias > 1) {
    return t('rotinas.agenda.resumoIntervalo', { dias: agenda.intervaloDias, horario })
  }
  if (agenda.dias?.length && agenda.dias.length < 7) {
    const ordenados = [...agenda.dias].sort((a, b) => a - b)
    const chave = ordenados.join(',')
    // Os dois conjuntos que quase toda rotina usa ganham nome próprio: listar
    // "Seg, Ter, Qua, Qui, Sex" ocupa a linha inteira do cartão sem dizer mais.
    if (chave === UTEIS) return t('rotinas.agenda.resumoUteis', { horario })
    if (chave === FIM_DE_SEMANA) return t('rotinas.agenda.resumoFimDeSemana', { horario })
    const nomes = diasAbreviados(t)
    return t('rotinas.agenda.resumoDias', { dias: ordenados.map((d) => nomes[d]).join(', '), horario })
  }
  return t('rotinas.agenda.resumoDiario', { horario })
}
