import { useEffect, useMemo } from 'react'
import { useToolsStore } from '~/stores/tools-store'
import { useWorkspaceStore } from '~/stores/workspace-store'
import { actionsForMode } from '@orbit/shared'
import type { SessionMode } from '@orbit/shared'

export interface SlashCommand {
  id: string
  label: string
  description?: string
  keywords?: string[]
  group: 'Ações' | 'Skills' | 'MCP' | 'Memória' | 'Modos'
  active?: boolean
  run: (ctx: { setText: (text: string) => void }) => void
}

export function useSlashCommands(): SlashCommand[] {
  const mode = useWorkspaceStore((s) => s.mode) as SessionMode
  const skills = useToolsStore((s) => s.skills)
  const mcpServers = useToolsStore((s) => s.mcpServers)
  const fetchSkills = useToolsStore((s) => s.fetchSkills)
  const fetchMcpStatus = useToolsStore((s) => s.fetchMcpStatus)
  const hydrateCache = useToolsStore((s) => s.hydrateCache)

  useEffect(() => {
    void hydrateCache()
    void Promise.all([fetchSkills(), fetchMcpStatus()])
  }, [fetchSkills, fetchMcpStatus, hydrateCache])

  return useMemo(() => {
    const toggle = (fn: () => void) => ({ setText }: { setText: (t: string) => void }) => {
      fn()
      setText('')
    }

    const items: SlashCommand[] = []

    // Actions
    items.push(
      ...actionsForMode(mode).map((action) => ({
        id: `action-${action.id}`,
        label: action.command,
        description: action.description,
        keywords: action.keywords,
        group: 'Ações' as const,
        run: ({ setText }: { setText: (t: string) => void }) =>
          setText(action.kind === 'insert' && action.insertText ? action.insertText : `${action.command} `),
      })),
    )

    // Skills (@slug)
    items.push(
      ...skills.map<SlashCommand>((skill) => ({
        id: `skill-${skill.slug}`,
        label: `@${skill.slug}`,
        description: skill.description || 'Skill do usuário',
        keywords: [skill.slug, skill.name],
        group: 'Skills' as const,
        run: ({ setText }) => setText(`@${skill.slug} `),
      })),
    )

    // MCP (@mcp:name)
    items.push(
      ...mcpServers
        .filter((s) => s.state === 'connected')
        .map<SlashCommand>((server) => ({
          id: `mcp-${server.config.name}`,
          label: `@mcp:${server.config.name}`,
          description: `Usar as ferramentas deste servidor MCP (${server.toolNames.length} tools)`,
          group: 'MCP' as const,
          run: ({ setText }) => setText(`@mcp:${server.config.name} `),
        })),
    )

    // Modos - toggles simples
    items.push({
      id: 'novo-chat',
      label: 'Nova conversa',
      description: 'Começa um chat em branco',
      keywords: ['clear', 'limpar', 'novo'],
      group: 'Ações',
      run: toggle(() => {}),
    })

    return items
  }, [mode, skills, mcpServers])
}
