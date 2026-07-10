/**
 * Skills: conhecimento curado pelo usuário (arquivos .skill/.md com frontmatter)
 * injetado no system prompt. Duas fontes mescladas — global (orbit-data/skills)
 * e projeto ({workspace}/.orbit/skills, só no code mode).
 */

export type SkillSource = "global" | "project"

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
}
