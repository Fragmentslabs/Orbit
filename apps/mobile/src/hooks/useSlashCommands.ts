import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useToolsStore } from '~/stores/tools-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { actionsForMode } from '@orbit/shared'
import type { SessionMode } from '@orbit/shared'

export interface SlashCommand {
  id: string
  label: string
  description?: string
  keywords?: string[]
  group: 'Actions' | 'Skills' | 'MCP' | 'Memory' | 'Modes'
  active?: boolean
  run: (ctx: { setText: (text: string) => void }) => void
}

/** Commands of the "/" palette — what gets EXECUTED (pipelines) and what acts on the
 *  UI. The references (skills, MCP) stay in the "@" palette. */
export function useSlashCommands(): SlashCommand[] {
  const { t } = useTranslation()
  const mode = useWorkspaceStore((s) => s.mode) as SessionMode
  const hydrateCache = useToolsStore((s) => s.hydrateCache)

  useEffect(() => {
    void hydrateCache()
  }, [hydrateCache])

  return useMemo(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText('')
    }

    const items: SlashCommand[] = []

    // "/" is for COMMANDS: what gets executed. The REFERENCES (skills, MCP)
    // stay in the "@" palette — see useReferenceCommands.
    items.push(
      ...actionsForMode(mode).map((action) => ({
        id: `action-${action.id}`,
        label: action.command,
        description: action.description,
        keywords: action.keywords,
        group: 'Actions' as const,
        run: ({ setText }: { setText: (t: string) => void }) =>
          setText(action.kind === 'insert' && action.insertText ? action.insertText : `${action.command} `),
      })),
    )

    // Modes - simple toggles
    items.push({
      id: 'new-chat',
      label: t('slashCommands.newConversation'),
      description: t('slashCommands.newConversationDesc'),
      keywords: ['clear', 'limpar', 'novo', 'new'],
      group: 'Actions',
      run: toggle(() => {}),
    })

    return items
  }, [mode, t])
}

/** References of the "@" palette: skills and MCP servers — what goes into
 *  the request context. On mobile there is no working folder, so there are no
 *  files to cite. */
export function useReferenceCommands(): SlashCommand[] {
  const { t } = useTranslation()
  const skills = useToolsStore((s) => s.skills)
  const mcpServers = useToolsStore((s) => s.mcpServers)
  const fetchSkills = useToolsStore((s) => s.fetchSkills)
  const fetchMcpStatus = useToolsStore((s) => s.fetchMcpStatus)
  const hydrateCache = useToolsStore((s) => s.hydrateCache)

  useEffect(() => {
    void hydrateCache()
    void Promise.all([fetchSkills(), fetchMcpStatus()])
  }, [fetchSkills, fetchMcpStatus, hydrateCache])

  return useMemo(
    () => [
      ...skills.map<SlashCommand>((skill) => ({
        id: `skill-${skill.slug}`,
        label: `@${skill.slug}`,
        description: skill.description || t('slashCommands.userSkill'),
        keywords: [skill.slug, skill.name],
        group: 'Skills' as const,
        run: ({ setText }: { setText: (t: string) => void }) => setText(`@${skill.slug} `),
      })),
      ...mcpServers
        .filter((s) => s.state === 'connected')
        .map<SlashCommand>((server) => ({
          id: `mcp-${server.config.name}`,
          label: `@mcp:${server.config.name}`,
          description: t('slashCommands.useMcpTools', { count: server.toolNames.length }),
          group: 'MCP' as const,
          run: ({ setText }: { setText: (t: string) => void }) => setText(`@mcp:${server.config.name} `),
        })),
    ],
    [skills, mcpServers, t],
  )
}
