/**
 * Skills: conhecimento curado (arquivos .skill/.md com frontmatter) injetado no
 * system prompt. Três fontes mescladas — builtin (nativas do app, somente
 * leitura), global (orbit-data/skills) e projeto ({workspace}/.orbit/skills,
 * só no code mode). A precedência é da mais específica para a menos:
 * projeto > global > builtin (uma skill global com o mesmo slug sobrescreve
 * a nativa).
 */

export type SkillSource = "builtin" | "global" | "project"

export interface Skill {
  /** Nome de exibição (pode conter espaços, maiúsculas) */
  name: string
  description: string
  /** Slug snake_case para referência @slug — único, derivado do nome mas editável */
  slug: string
  /** Corpo markdown (após o frontmatter) */
  content: string
  source: SkillSource
  filePath: string
  /** Arquivos auxiliares do bundle (scripts/funções) — caminhos absolutos */
  scripts?: string[]
}

/** Skill proposta pelo agente (create_skill) aguardando aprovação do usuário */
export interface SkillProposal {
  slug: string
  name: string
  description: string
  content: string
  /** Nomes relativos dos arquivos auxiliares incluídos na proposta */
  files: string[]
}
