import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { KeyRound, Plug, RefreshCw } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { McpServerConfig, McpServerStatus, ToolPart } from '@orbit/shared'
import { Storage } from '~/lib/storage'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import { useToolsStore } from '~/stores/tools-store'
import { MONO_FONT, ProposalAction, ProposalCard } from './ProposalCard'

/**
 * Card of the MCP connection proposal (tools mcp_connect / mcp_update) — mirrors the
 * desktop McpProposalCard: nothing was written when the tool ran; the connection
 * only goes into the config on "Connect". The state comes from the real status of the
 * servers: not saved -> Connect; saved without token -> Authorize (the login
 * opens in the desktop browser); connected -> check.
 */

const DISMISSED_KEY = 'orbit_mcp_proposals_dismissed'

interface ProposalInput {
  name: string
  type: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string }
  enabled?: boolean
  permissionMode?: 'ask' | 'approve' | 'full'
  /** Only from mcp_update: why the connection is being changed. */
  reason?: string
}

function needsAuth(server: McpServerStatus): boolean {
  if (!server.usesOAuth) return false
  return !server.authorized || server.state === 'unauthorized'
}

function mask(value: string): string {
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-2)}`
}

/** Headers and client_secret cannot appear in full in the card. */
function secretsOf(input: ProposalInput): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = []
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (/authorization|token|key|secret|cookie/i.test(key)) out.push({ key, value: mask(value) })
  }
  if (input.oauth?.clientSecret) out.push({ key: 'client_secret', value: mask(input.oauth.clientSecret) })
  return out
}

/** Final config: the change starts from the current entry (only the fields sent change). */
function toConfig(input: ProposalInput, current?: McpServerConfig): McpServerConfig {
  const { reason: _reason, ...changes } = input
  return { ...(current ?? {}), ...changes, name: input.name } as McpServerConfig
}

export function McpProposalCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))
  const servers = useToolsStore((s) => s.mcpServers)
  const fetchMcpStatus = useToolsStore((s) => s.fetchMcpStatus)
  const saveMcpConfig = useToolsStore((s) => s.saveMcpConfig)
  const reconnectMcp = useToolsStore((s) => s.reconnectMcp)
  const authorizeMcp = useToolsStore((s) => s.authorizeMcp)
  const [busy, setBusy] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])

  useEffect(() => {
    Storage.getItem(DISMISSED_KEY)
      .then((raw) => {
        const parsed: unknown = raw ? JSON.parse(raw) : []
        if (Array.isArray(parsed)) setDismissed(parsed.filter((x): x is string => typeof x === 'string'))
      })
      .catch(() => {})
  }, [])

  // The proposal is born during the execution of the tool; when it ends, the real
  // status is read back — it is what says whether it is already saved, whether authorization is missing, etc.
  useEffect(() => {
    if (part.state === 'done') void fetchMcpStatus()
  }, [part.state, fetchMcpStatus])

  if (part.state === 'running') {
    return (
      <View style={[s.wrap, s.loading, { borderColor: tokens.border, backgroundColor: tokens.card }]}>
        <ActivityIndicator size="small" color={tokens.primary} />
        <Text style={[s.loadingText, { color: tokens.mutedForeground }]}>{t('mcpProposal.building')}</Text>
      </View>
    )
  }
  if (part.state === 'error') return null

  const input = part.input as unknown as ProposalInput | undefined
  if (!input?.name || !input.type) return null

  const name = input.name
  const status = servers.find((sv) => sv.config.name === name)
  const secret = secretsOf(input)
  const target = input.url ?? input.command ?? ''

  function persistDismissed(next: string[]): void {
    setDismissed(next)
    void Storage.setItem(DISMISSED_KEY, JSON.stringify(next))
  }

  async function run(action: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(action)
    try {
      await fn()
    } finally {
      setBusy(null)
      await fetchMcpStatus()
    }
  }

  /** Saves the proposed connection (creating or changing) — only here, on tap. */
  async function connect(): Promise<void> {
    await fetchMcpStatus()
    const existing = useToolsStore.getState().mcpServers.map((sv) => sv.config)
    const current = existing.find((c) => c.name === name)
    const entry = toConfig(input as ProposalInput, current)
    await saveMcpConfig({ servers: [...existing.filter((c) => c.name !== name), entry] })
    persistDismissed(dismissed.filter((d) => d !== name))
  }

  const wasDiscarded = dismissed.includes(name)
  const connected = status?.state === 'connected'
  const discardedHere = wasDiscarded && !status
  const badge = connected
    ? { label: t('proposalCard.connected'), tone: 'success' as const }
    : discardedHere
      ? { label: t('proposalCard.discarded') }
      : { label: input.type }

  const facts = [
    ...(target ? [{ label: t('proposalCard.target'), value: target, mono: true }] : []),
    ...(input.reason ? [{ label: t('proposalCard.reason'), value: input.reason }] : []),
  ]

  const note = connected
    ? t('proposalCard.tools', { count: status?.toolNames.length ?? 0 })
    : status?.error
      ? t('mcpProposal.failed', { error: status.error })
      : status && needsAuth(status)
        ? t('mcpProposal.needsAuth')
        : discardedHere
          ? t('mcpProposal.discarded')
          : undefined

  const actions = connected || discardedHere ? undefined : !status ? (
    <>
      <ProposalAction
        label={t('mcpProposal.discard')}
        variant="ghost"
        disabled={busy !== null}
        onPress={() => persistDismissed([...new Set([...dismissed, name])])}
      />
      <ProposalAction
        label={t('mcpProposal.connect')}
        variant="primary"
        disabled={busy !== null}
        icon={
          busy === 'connect' ? <ActivityIndicator size="small" color={tokens.primaryForeground} /> : undefined
        }
        onPress={() => void run('connect', connect)}
      />
    </>
  ) : (
    <>
      <ProposalAction
        label={busy === 'retry' ? t('mcpProposal.retrying') : t('mcpProposal.retry')}
        variant="outline"
        disabled={busy !== null}
        icon={<RefreshCw size={13} color={tokens.foreground} />}
        onPress={() => void run('retry', () => reconnectMcp(name))}
      />
      {needsAuth(status) && (
        <ProposalAction
          label={
            busy === 'auth'
              ? t('mcpProposal.authorizing')
              : status.authorized
                ? t('mcpProposal.reauthorize')
                : t('mcpProposal.authorize')
          }
          variant="primary"
          disabled={busy !== null}
          icon={<KeyRound size={13} color={tokens.primaryForeground} />}
          onPress={() => void run('auth', () => authorizeMcp(name))}
        />
      )}
    </>
  )

  return (
    <View style={s.wrap}>
      <ProposalCard
        icon={<Plug size={16} color={tokens.mutedForeground} />}
        kind={t('proposalCard.mcp')}
        title={name}
        badge={badge}
        facts={facts}
        note={note}
        noteTone={status?.error ? 'destructive' : status && needsAuth(status) ? 'warning' : 'muted'}
        actions={actions}
      >
        {secret.length > 0 ? (
          <View style={s.secrets}>
            <Text style={[s.secretsLabel, { color: tokens.mutedForeground }]}>{t('proposalCard.secrets')}</Text>
            <View style={s.secretWrap}>
              {secret.map((item) => (
                <View key={item.key} style={[s.secret, { backgroundColor: tokens.muted }]}>
                  <KeyRound size={11} color={tokens.mutedForeground} />
                  <Text style={[s.secretText, { color: tokens.mutedForeground }]}>
                    {item.key}: {item.value}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </ProposalCard>
    </View>
  )
}

const s = StyleSheet.create({
  wrap: { marginVertical: 4, width: '100%' },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
  },
  loadingText: { fontSize: 13 },
  secrets: { gap: 6 },
  secretsLabel: { fontSize: 11 },
  secretWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  secret: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  secretText: { fontSize: 10, fontFamily: MONO_FONT },
})
