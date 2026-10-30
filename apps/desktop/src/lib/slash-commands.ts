import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"

import type { SessionMode } from "@shared/chat"
import { normalizeText } from "@shared/memory"
import { actionsForMode } from "@/src/lib/slash-actions"
import { useSkillsStore } from "@/src/stores/skills-store"

/**
 * Palette "/" commands (data + hooks, without JSX — the visual component is
 * SlashPalette). Groups in display order: Actions → Skills → MCP → Memory
 * → Modes.
 */

export interface SlashCommand {
  id: string
  label: string
  description?: string
  keywords?: string[]
  group: "Modes" | "Skills" | "MCP" | "Memory" | "Actions"
  /** Current state of the toggle (dot on the right) */
  active?: boolean
  /** Disabled item (e.g. Loop in the orchestra) — greys out and does nothing */
  disabled?: boolean
  run: (ctx: { setText: (text: string) => void }) => void
}

/** The command matches the query if all the terms appear in the label,
 *  description or keywords. */
export function commandMatches(command: SlashCommand, query: string): boolean {
  if (!query) return true
  const haystack = normalizeText(
    [command.label, command.description ?? "", ...(command.keywords ?? [])].join(" "),
  )
  return query.split(" ").every((token) => haystack.includes(token))
}

/**
 * Composer `@` references. Skills only count in code mode. MCP servers
 * count in both modes (the tools have no on/off) and respect the conversation's
 * `options.servers` scope, so as not to cite a server this turn does not
 * expose.
 */
export function useReferenceCommands(
  mode?: SessionMode,
  options?: { servers?: string[] | null },
): SlashCommand[] {
  const skills = useSkillsStore((s) => s.skills)
  const mcpServers = useSkillsStore((s) => s.mcpServers)
  const initialize = useSkillsStore((s) => s.initialize)
  const { t } = useTranslation()
  const only = options?.servers

  useEffect(() => {
    void initialize()
  }, [initialize])

  return useMemo<SlashCommand[]>(
    () => {
      const inCode = !mode || mode === "code"
      return [
        ...(inCode
          ? skills.map<SlashCommand>((skill) => ({
              id: `skill-${skill.slug}`,
              label: `@${skill.slug}`,
              description: skill.description || t("input.slash.userSkill"),
              keywords: [skill.slug, skill.name],
              group: "Skills",
              run: ({ setText }) => setText(`@${skill.slug} `),
            }))
          : []),
        ...mcpServers
          .filter((s) => s.state === "connected" && (!only || only.includes(s.config.name)))
          .map<SlashCommand>((server) => ({
            id: `mcp-${server.config.name}`,
            label: `@mcp:${server.config.name}`,
            description: t("input.slash.mcpServer", { count: server.toolNames.length }),
            group: "MCP",
            run: ({ setText }) => setText(`@mcp:${server.config.name} `),
          })),
      ]
    },
    [skills, mcpServers, mode, only, t],
  )
}

/** "/" Actions (pipelines from src/lib/slash-actions) as palette commands.
 * Selecting inserts the command (or the reference text) into the input — the send
 * is resolved by the inputs' submit via resolveSlashAction. */
export function useSlashActionCommands(mode: SessionMode): SlashCommand[] {
  return useMemo<SlashCommand[]>(
    () =>
      actionsForMode(mode).map((action) => ({
        id: `action-${action.id}`,
        label: action.command,
        description: action.description,
        keywords: action.keywords,
        group: "Actions",
        run: ({ setText }) =>
          setText(action.kind === "insert" && action.insertText ? action.insertText : `${action.command} `),
      })),
    [mode],
  )
}
