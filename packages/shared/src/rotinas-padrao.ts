import type { Agenda, RotinaModos } from './rotinas'

/**
 * Rotinas de manutenção que acompanham o Orbit, criadas DESATIVADAS.
 *
 * Existem porque as duas coisas que mais acumulam sujeira — chats velhos e
 * memórias esquecidas — não têm limpeza automática hoje: o cleanup do Brain só
 * alcança memórias com prazo (seasonal e project/context), que são a minoria,
 * e chats nunca são tocados.
 *
 * Ambas são modo CHAT, e isso é deliberado: nenhuma das duas precisa ler
 * arquivos. Consolidar memória mexe em ids (memory_list / memory_update /
 * memory_delete / memory_link), não no código — dar uma pasta de trabalho a
 * elas concederia leitura do disco sem necessidade. Como consequência, a
 * consolidação não tem como VERIFICAR obsolescência, e os prompts proíbem
 * concluí-la: isso é trabalho de uma rotina de código, por projeto, que o
 * usuário monta quando quiser.
 *
 * Os prompts são escritos em inglês (como os demais prompts do produto) e
 * mandam responder no idioma do usuário — `Rotina.language` carrega essa
 * preferência até o agente.
 *
 * Ambos mandam ARQUIVAR/consolidar, nunca apagar por padrão. O usuário pode
 * reescrever o prompt para excluir — as ferramentas suportam —, mas essa passa
 * a ser uma escolha explícita dele, não o comportamento de fábrica de algo que
 * roda sozinho.
 */

export interface RotinaPadrao {
  /** Identidade estável — marca que este preset já foi semeado uma vez. */
  id: string
  titulo: string
  prompt: string
  agenda: Agenda
  modos: RotinaModos
  mode: 'chat' | 'code'
}

const MODOS_MANUTENCAO: RotinaModos = {
  loop: true,
  subagents: false,
  orchestrate: false,
  brain: true,
  browser: false,
  search: false,
  vision: false,
  plan: false,
  simple: false,
}

export const ROTINAS_PADRAO: RotinaPadrao[] = [
  {
    id: 'padrao:limpeza-chats',
    titulo: 'Arquivar chats inativos',
    agenda: { horario: '03:00', dias: [1] },
    modos: MODOS_MANUTENCAO,
    mode: 'chat',
    prompt: `Archive chats that fell out of use, so the sidebar stays readable.

You run unattended, with nobody to ask. Do not ask questions and do not request approval.
Write your reply in the user's language.

STEPS
1. Call chat_list with inactiveDays=30 to see chats untouched for 30 days or more.
   The tool already leaves out what is not a candidate: pinned chats, chats that
   are already archived, orchestration sub-sessions and routine runs.
2. Read the titles. Archive with chat_archive the ones that clearly served their
   purpose — one-off questions already answered, throwaway tests, single-exchange
   conversations, generic titles like "New chat".
3. Do NOT archive anything that looks like living reference: architecture
   decisions, long investigations, any chat whose title suggests it will be
   consulted again. When unsure, leave it alone — erring towards keeping costs
   almost nothing.
4. Reply with a summary: how many you archived and their titles, plus how many
   you looked at and decided to keep, with a one-line reason each.

RULES
- ARCHIVE, NEVER DELETE. Archiving is reversible: the chat leaves the sidebar,
  its messages stay intact, and it returns to its place if unarchived. The
  chat_delete tool exists, but erasing the user's own messages is not something
  an unattended routine should decide on its own.
- An archived chat keeps its folder, so there is nothing to move.
- Do not touch files, do not run commands, do not change anything but the chats.`,
  },
  {
    id: 'padrao:limpeza-memorias',
    titulo: 'Consolidar memórias',
    agenda: { horario: '03:30', dias: [1] },
    modos: MODOS_MANUTENCAO,
    mode: 'chat',
    prompt: `Review the stored memories: merge what is duplicated and reconnect what got
orphaned. Only memories with an expiry are cleaned automatically, and those are
the minority — everything else piles up with nobody ever reviewing it.

You run unattended, with nobody to ask. Do not ask questions and do not request approval.
Write your reply in the user's language.

STEPS
1. Call memory_list with includeProjectMemories=true to see what fell into
   disuse across every project. It sorts from least used to most used and shows
   hits, age and last use. memory_search is the wrong tool here: it ranks by
   lexical relevance and therefore hides exactly the forgotten memories you are
   looking for.
2. Look for DUPLICATES: two or more memories saying the same thing in different
   words. For each group pick the one with the most hits and the most
   connections, and rewrite its text with memory_update so it absorbs whatever
   the others added. Only then delete the absorbed ones with memory_delete.
   Preferring update over delete is not a detail: the surviving memory keeps its
   id, its links and its accumulated usage, all of which deleting throws away.
3. Look for ORPHANS: call memory_list with onlyOrphans=true. Connect the ones
   that still make sense with memory_link, hanging each off the memory it
   belongs with.
4. Fix MISCLASSIFICATION: a memory saved as kind="general" whose text names a
   specific project's entities, schema, routes or business rules belongs to that
   project. Correct it with memory_update.
5. Reply with a summary: what was merged (text before and after), what was
   deleted and why, and what was reconnected.

RULES
- NEVER merge memories from different projects. Similar wording across projects
  is shared vocabulary, not duplication — two "Project Overview" memories
  describe different projects and must stay separate. Check projectId before
  concluding two memories are the same.
- You CANNOT verify obsolescence. This routine has no working folder and cannot
  read code, so never delete something for "looking outdated" — you have no way
  to confirm it. Delete only what is redundant (absorbed in step 2) or plainly
  self-contradictory.
- Low usage is NOT a reason to delete. A rarely needed convention is still
  correct when its subject comes up.
- When unsure whether two memories are duplicates, keep both. Merging wrongly
  loses information and nobody notices.
- Do not touch files and do not run commands.`,
  },
]
