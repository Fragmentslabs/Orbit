import { useEffect, useMemo } from "react"

import type { SessionMode } from "@/shared/chat"
import { actionsForMode } from "@/src/lib/slash-actions"
import { useSkillsStore } from "@/src/stores/skills-store"

/**
 * Comandos do palette "/" (dados + hooks, sem JSX — o componente visual é o
 * SlashPalette). Grupos na ordem de exibição: Ações → Skills → MCP → Memória
 * → Modos.
 */

export interface SlashCommand {
  id: string
  label: string
  description?: string
  keywords?: string[]
  group: "Modos" | "Skills" | "MCP" | "Memória" | "Ações"
  /** Estado atual do toggle (bolinha à direita) */
  active?: boolean
  run: (ctx: { setText: (text: string) => void }) => void
}

/** Skills + MCP como comandos de referência (@...) — comum aos dois inputs. */
export function useReferenceCommands(): SlashCommand[] {
  const skills = useSkillsStore((s) => s.skills)
  const mcpServers = useSkillsStore((s) => s.mcpServers)
  const initialize = useSkillsStore((s) => s.initialize)

  useEffect(() => {
    void initialize()
  }, [initialize])

  return useMemo<SlashCommand[]>(
    () => [
      ...skills.map<SlashCommand>((skill) => ({
        id: `skill-${skill.slug}`,
        label: `@${skill.slug}`,
        description: skill.description || "Skill do usuário",
        keywords: [skill.slug, skill.name],
        group: "Skills",
        run: ({ setText }) => setText(`@${skill.slug} `),
      })),
      ...mcpServers
        .filter((s) => s.state === "connected")
        .map<SlashCommand>((server) => ({
          id: `mcp-${server.config.name}`,
          label: `@mcp:${server.config.name}`,
          description: `Usar as ferramentas deste servidor MCP (${server.toolNames.length} tools)`,
          group: "MCP",
          run: ({ setText }) => setText(`@mcp:${server.config.name} `),
        })),
    ],
    [skills, mcpServers],
  )
}

/** Ações "/" (pipelines de src/lib/slash-actions) como comandos do palette.
 * Selecionar insere o comando (ou o texto de referência) no input — o envio
 * é resolvido pelo submit dos inputs via resolveSlashAction. */
export function useSlashActionCommands(mode: SessionMode): SlashCommand[] {
  return useMemo<SlashCommand[]>(
    () =>
      actionsForMode(mode).map((action) => ({
        id: `action-${action.id}`,
        label: action.command,
        description: action.description,
        keywords: action.keywords,
        group: "Ações",
        run: ({ setText }) =>
          setText(action.kind === "insert" && action.insertText ? action.insertText : `${action.command} `),
      })),
    [mode],
  )
}
