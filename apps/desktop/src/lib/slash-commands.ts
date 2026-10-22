import { useEffect, useMemo } from "react"
import { useTranslation } from "react-i18next"

import type { SessionMode } from "@shared/chat"
import { normalizeText } from "@shared/memory"
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
  /** Item desabilitado (ex.: Loop na orquestra) — some, mas não faz nada */
  disabled?: boolean
  run: (ctx: { setText: (text: string) => void }) => void
}

/** O comando casa com a query se todos os termos aparecerem no rótulo,
 *  descrição ou palavras-chave. */
export function commandMatches(command: SlashCommand, query: string): boolean {
  if (!query) return true
  const haystack = normalizeText(
    [command.label, command.description ?? "", ...(command.keywords ?? [])].join(" "),
  )
  return query.split(" ").every((token) => haystack.includes(token))
}

/**
 * Referências `@` do composer. Skills valem só no modo código. Servidores MCP
 * valem nos dois modos (as tools não têm liga/desliga) e respeitam o recorte
 * `options.servers` da conversa, para não citar servidor que este turno não
 * expõe.
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
            description: `Usar as ferramentas deste servidor MCP (${server.toolNames.length} tools)`,
            group: "MCP",
            run: ({ setText }) => setText(`@mcp:${server.config.name} `),
          })),
      ]
    },
    [skills, mcpServers, mode, only, t],
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
