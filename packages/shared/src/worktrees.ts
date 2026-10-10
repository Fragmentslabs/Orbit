/**
 * Worktrees nos chats (seletor no header e ferramentas worktree_* do agente).
 * O worktree por task da esteira usa WorktreeDaTask, em esteira.ts.
 */

/** De onde o worktree veio — define o que o seletor deixa fazer com ele. */
export type OrigemWorktree =
  /** A cópia de trabalho principal do repositório */
  | 'principal'
  /** Criado pelos chats do Orbit (orbit-data/worktrees/chats) */
  | 'chat'
  /** De uma task da esteira — quem remove é a esteira */
  | 'esteira'
  /** Criado fora do Orbit (git worktree add à mão, outra ferramenta) */
  | 'externo'

export interface WorktreeInfo {
  /** Raiz do worktree */
  caminho: string
  /** Pasta equivalente à do chat dentro dele (mesma subpasta, em monorepo) */
  pasta: string
  nome: string
  /** Ausente em detached HEAD */
  branch?: string
  /** Commit atual, abreviado */
  head: string
  principal: boolean
  origem: OrigemWorktree
  /** false quando a pasta sumiu (o git ainda tem o registro) */
  disponivel: boolean
  travado: boolean
  /** Arquivos com alterações não commitadas */
  alteracoes: number
  /** Commits no branch dele que o branch do principal ainda não tem */
  aFrente: number
}

export interface ListaWorktrees {
  /** Raiz do repositório principal */
  repo: string
  /** Raiz do worktree em que a pasta consultada está */
  atual: string
  /** O principal vem primeiro */
  worktrees: WorktreeInfo[]
}

export interface CriarWorktreeResultado {
  caminho: string
  /** Pasta para o chat usar (a mesma subpasta em que ele estava) */
  pasta: string
  branch: string
  base: string
  dependencias: 'clonadas' | 'vinculadas' | 'nenhuma'
}
