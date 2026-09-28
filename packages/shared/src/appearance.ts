/**
 * Onde a persona aparece.
 *
 * Eram duas aparições com custos diferentes tratadas por um booleano só: a da
 * tela de chat novo é a saudação, e não disputa espaço com nada porque não há
 * conversa ainda; a do topo flutua SOBRE a lista de mensagens, e cobra por
 * isso um respiro no começo da lista e um véu de degradê. Quem desliga quase
 * sempre está incomodado com a segunda, e com um interruptor perdia as duas.
 *
 * Os valores dizem onde ela FICA, não o que ela esconde: é o que o seletor
 * mostra, e ler a preferência tem que ser a mesma leitura nas duas telas.
 */
export type PersonaVisibility =
  /** No chat novo e por cima da conversa. */
  | 'all'
  /** Só na saudação do chat novo — a conversa fica limpa. */
  | 'welcome'
  /** Em lugar nenhum. */
  | 'none'

export const PERSONA_VISIBILITY: PersonaVisibility[] = ['all', 'welcome', 'none']

export const DEFAULT_PERSONA_VISIBILITY: PersonaVisibility = 'all'

/** Migração do booleano antigo: quem tinha desligado queria sumir com tudo. */
export function personaVisibilityFrom(
  stored: string | null | undefined,
): PersonaVisibility {
  if (stored && (PERSONA_VISIBILITY as string[]).includes(stored)) {
    return stored as PersonaVisibility
  }
  if (stored === 'false') return 'none'
  if (stored === 'true') return 'all'
  return DEFAULT_PERSONA_VISIBILITY
}

/** A persona flutuante, que passa por cima da conversa. */
export function showsPersonaInChat(visibility: PersonaVisibility): boolean {
  return visibility === 'all'
}

/** A saudação da tela de chat novo. */
export function showsPersonaOnWelcome(visibility: PersonaVisibility): boolean {
  return visibility !== 'none'
}
