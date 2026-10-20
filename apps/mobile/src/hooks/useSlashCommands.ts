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
  group: 'Ações' | 'Skills' | 'MCP' | 'Memória' | 'Modos'
  active?: boolean
  run: (ctx: { setText: (text: string) => void }) => void
}

/** Comandos da paleta "/" — o que se EXECUTA (pipelines) e o que se age na
 *  UI. As referências (skills, MCP) ficam na paleta "@". */
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

    // A "/" é de COMANDOS: o que se executa. As REFERÊNCIAS (skills, MCP)
    // ficam na paleta "@" — ver useReferenceCommands.
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

    // Modos - toggles simples
    items.push({
      id: 'novo-chat',
      label: t('slashCommands.newConversation'),
      description: t('slashCommands.newConversationDesc'),
      keywords: ['clear', 'limpar', 'novo', 'new'],
      group: 'Ações',
      run: toggle(() => {}),
    })

    return items
  }, [mode, t])
}

/** Referências da paleta "@": skills e servidores MCP — o que entra no
 *  contexto do pedido. No mobile não há pasta de trabalho, então não há
 *  arquivos para citar. */
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
