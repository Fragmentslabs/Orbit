import { useEffect, useState } from 'react'
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native'
import { AlertCircle, Check, KeyRound, Plug, RefreshCw } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import { useToolsStore } from '~/stores/tools-store'
import { Storage } from '~/lib/storage'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'
import type { McpServerConfig, McpServerStatus, ToolPart } from '@orbit/shared'

/**
 * Card da proposta de conexão MCP (tools mcp_connect / mcp_update) — espelha o
 * McpProposalCard do desktop: nada foi gravado quando a tool rodou; a conexão
 * só vai para a config no "Conectar". O estado vem do status real dos
 * servidores: não salvo -> Conectar; salvo sem token -> Autorizar (o login
 * abre no navegador do desktop); conectado -> check.
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
  /** Só do mcp_update: por que a conexão está sendo alterada. */
  reason?: string
}

function needsAuth(server: McpServerStatus): boolean {
  if (!server.usesOAuth) return false
  return !server.authorized || server.state === 'unauthorized'
}

function mask(value: string): string {
  return value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-2)}`
}

/** Cabeçalhos e client_secret não podem aparecer inteiros no card. */
function secretsOf(input: ProposalInput): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (/authorization|token|key|secret|cookie/i.test(key)) out.push({ key, value: mask(value) })
  }
  if (input.oauth?.clientSecret) out.push({ key: 'client_secret', value: mask(input.oauth.clientSecret) })
  return out
}

/** Config final: alteração parte da entrada atual (só os campos enviados mudam). */
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

  // A proposta nasce durante a execução da tool; quando ela termina, o status
  // real é relido — é ele que diz se já está salvo, se falta autorizar, etc.
  useEffect(() => {
    if (part.state === 'done') void fetchMcpStatus()
  }, [part.state, fetchMcpStatus])

  const card = [s.card, { borderColor: tokens.border, backgroundColor: tokens.card }]

  if (part.state === 'running') {
    return (
      <View style={[card, s.row]}>
        <ActivityIndicator size="small" color={tokens.primary} />
        <Text style={[s.statusText, { color: tokens.mutedForeground }]}>{t('mcpProposal.building')}</Text>
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

  /** Grava a conexão proposta (criando ou alterando) — só aqui, no toque. */
  async function connect(): Promise<void> {
    await fetchMcpStatus()
    const existing = useToolsStore.getState().mcpServers.map((sv) => sv.config)
    const current = existing.find((c) => c.name === name)
    const entry = toConfig(input as ProposalInput, current)
    await saveMcpConfig({ servers: [...existing.filter((c) => c.name !== name), entry] })
    persistDismissed(dismissed.filter((d) => d !== name))
  }

  const wasDiscarded = dismissed.includes(name)

  return (
    <View style={card}>
      <View style={s.row}>
        <View style={[s.iconWrap, { backgroundColor: 'rgba(99,102,241,0.12)' }]}>
          <Plug size={16} color="#818cf8" />
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.titleRow}>
            <Text style={[s.title, { color: tokens.foreground }]}>{name}</Text>
            <Text style={[s.badge, { color: tokens.mutedForeground, borderColor: tokens.border }]}>{input.type}</Text>
          </View>
          {!!target && (
            <Text style={[s.mono, { color: tokens.mutedForeground }]} numberOfLines={1}>
              {target}
            </Text>
          )}
          {!!input.reason && <Text style={[s.desc, { color: tokens.mutedForeground }]}>{input.reason}</Text>}
          {secret.length > 0 && (
            <View style={s.secrets}>
              {secret.map((item) => (
                <View key={item.key} style={[s.secret, { backgroundColor: tokens.muted }]}>
                  <KeyRound size={11} color={tokens.mutedForeground} />
                  <Text style={[s.secretText, { color: tokens.mutedForeground }]}>
                    {item.key}: {item.value}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>

      {status?.state === 'connected' ? (
        <View style={s.row}>
          <Check size={14} color="#22c55e" />
          <Text style={[s.statusText, { color: '#22c55e' }]}>
            {t('mcpProposal.connected', { count: status.toolNames.length })}
          </Text>
        </View>
      ) : wasDiscarded && !status ? (
        <Text style={[s.statusText, { color: tokens.mutedForeground }]}>{t('mcpProposal.discarded')}</Text>
      ) : !status ? (
        <View style={[s.actions, { borderTopColor: tokens.border }]}>
          <Pressable
            disabled={busy !== null}
            onPress={() => persistDismissed([...new Set([...dismissed, name])])}
            style={[s.btn, { borderColor: tokens.border }]}
          >
            <Text style={[s.btnText, { color: tokens.foreground }]}>{t('mcpProposal.discard')}</Text>
          </Pressable>
          <Pressable
            disabled={busy !== null}
            onPress={() => void run('connect', connect)}
            style={[s.btn, { backgroundColor: tokens.primary, opacity: busy ? 0.6 : 1 }]}
          >
            {busy === 'connect' ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={[s.btnText, { color: '#fff' }]}>{t('mcpProposal.connect')}</Text>
            )}
          </Pressable>
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          {!!status.error && (
            <View style={s.row}>
              <AlertCircle size={14} color="#ef4444" />
              <Text style={[s.statusText, { color: '#ef4444', flex: 1 }]}>
                {t('mcpProposal.failed', { error: status.error })}
              </Text>
            </View>
          )}
          {needsAuth(status) && !status.error && (
            <Text style={[s.statusText, { color: '#f59e0b' }]}>{t('mcpProposal.needsAuth')}</Text>
          )}
          <View style={[s.actions, { borderTopColor: tokens.border }]}>
            <Pressable
              disabled={busy !== null}
              onPress={() => void run('retry', () => reconnectMcp(name))}
              style={[s.btn, s.btnRow, { borderColor: tokens.border }]}
            >
              <RefreshCw size={13} color={tokens.foreground} />
              <Text style={[s.btnText, { color: tokens.foreground }]}>
                {busy === 'retry' ? t('mcpProposal.retrying') : t('mcpProposal.retry')}
              </Text>
            </Pressable>
            {needsAuth(status) && (
              <Pressable
                disabled={busy !== null}
                onPress={() => void run('auth', () => authorizeMcp(name))}
                style={[s.btn, s.btnRow, { backgroundColor: tokens.primary }]}
              >
                <KeyRound size={13} color="#fff" />
                <Text style={[s.btnText, { color: '#fff' }]}>
                  {busy === 'auth'
                    ? t('mcpProposal.authorizing')
                    : status.authorized
                      ? t('mcpProposal.reauthorize')
                      : t('mcpProposal.authorize')}
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8, marginVertical: 4, width: '100%' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  iconWrap: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14, fontWeight: '600' },
  badge: { fontSize: 10, borderWidth: 1, borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 },
  mono: { fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  desc: { fontSize: 12, lineHeight: 16, marginTop: 2 },
  secrets: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  secret: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2 },
  secretText: { fontSize: 10, fontFamily: 'monospace' },
  statusText: { fontSize: 12 },
  actions: { flexDirection: 'row', gap: 8, paddingTop: 10, borderTopWidth: 1 },
  btn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnRow: { flexDirection: 'row', gap: 6 },
  btnText: { fontSize: 12, fontWeight: '600' },
})
