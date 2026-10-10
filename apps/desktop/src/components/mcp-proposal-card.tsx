import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { AlertCircle, Check, KeyRound, Plug, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { ToolPart } from "@shared/chat"
import type { McpServerConfig, McpServerStatus } from "@shared/mcp"
import { Shimmer } from "@/src/components/ai/shimmer"
import { mcpApi } from "@/src/lib/ipc"
import { useSkillsStore } from "@/src/stores/skills-store"

/**
 * Card da proposta de conexão MCP (tools mcp_connect / mcp_update): a conexão
 * fica PROPOSTA até o usuário aceitar aqui — nada foi gravado quando a tool
 * rodou. Estado derivado do status real dos servidores (o mesmo que a aba de
 * MCPs usa): não salvo -> Conectar; salvo sem token -> Autorizar (abre a
 * página de login do provedor, como o Figma); conectado -> check.
 */

const DISMISSED_KEY = "orbit_mcp_proposals_dismissed"

/** Campos que a tool aceita e que viram config (o resto é só apresentação). */
interface ProposalInput {
  name: string
  type: "http" | "stdio"
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
  oauth?: { clientId?: string; clientSecret?: string; scope?: string }
  enabled?: boolean
  permissionMode?: "ask" | "approve" | "full"
  /** Só do mcp_update: por que a conexão está sendo alterada. */
  reason?: string
}

function loadDismissed(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []
  } catch {
    return []
  }
}

/** O mesmo critério da aba de MCPs: OAuth que nunca autorizou ou caiu em 401. */
function needsAuth(server: McpServerStatus): boolean {
  if (!server.usesOAuth) return false
  return !server.authorized || server.state === "unauthorized"
}

function mask(value: string): string {
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}••••${value.slice(-2)}`
}

/** Cabeçalhos e client_secret não podem aparecer inteiros no card. */
function secretsOf(input: ProposalInput): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (/authorization|token|key|secret|cookie/i.test(key)) out.push({ key, value: mask(value) })
  }
  if (input.oauth?.clientSecret) out.push({ key: "client_secret", value: mask(input.oauth.clientSecret) })
  return out
}

/** Config final: alteração parte da entrada atual (só os campos enviados mudam). */
function toConfig(input: ProposalInput, current?: McpServerConfig): McpServerConfig {
  const { reason: _reason, ...changes } = input
  return { ...(current ?? {}), ...changes, name: input.name } as McpServerConfig
}

export function McpProposalCard({ part }: { part: ToolPart }) {
  const { t } = useTranslation()
  const initialize = useSkillsStore((s) => s.initialize)
  const refresh = useSkillsStore((s) => s.refresh)
  const servers = useSkillsStore((s) => s.mcpServers)
  const [busy, setBusy] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string[]>(loadDismissed)

  useEffect(() => {
    void initialize()
  }, [initialize])

  // A proposta nasce durante a execução da tool; quando ela termina, o status
  // real é relido — é ele que diz se já está salvo, se falta autorizar, etc.
  useEffect(() => {
    if (part.state === "done") void refresh()
  }, [part.state, refresh])

  if (part.state === "running") {
    return <Shimmer className="text-sm">{t("mcpProposal.building")}</Shimmer>
  }
  if (part.state === "error") return null

  const input = part.input as unknown as ProposalInput | undefined
  if (!input?.name || !input.type) return null

  const name = input.name
  const status = servers.find((s) => s.config.name === name)
  const secret = secretsOf(input)
  const target = input.url ?? input.command ?? ""

  async function run(action: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(action)
    try {
      await fn()
    } finally {
      setBusy(null)
      await refresh()
    }
  }

  /** Grava a conexão proposta (criando ou alterando) — só aqui, no clique. */
  async function connect(): Promise<void> {
    const config = await mcpApi.config()
    const current = config.servers.find((s) => s.name === name)
    const entry = toConfig(input as ProposalInput, current)
    const servers2 = config.servers.filter((s) => s.name !== name)
    await mcpApi.save({ servers: [...servers2, entry] })
    setDismissed((prev) => {
      const next = prev.filter((d) => d !== name)
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
      return next
    })
  }

  function discard(): void {
    setDismissed((prev) => {
      const next = [...new Set([...prev, name])]
      localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
      return next
    })
  }

  const wasDiscarded = dismissed.includes(name)

  return (
    <div className="not-prose my-2 flex w-full flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-start gap-2">
        <Plug className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{name}</span>
            <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
              {input.type}
            </Badge>
          </div>
          {target && <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{target}</p>}
          {input.reason && <p className="mt-0.5 text-xs text-muted-foreground">{input.reason}</p>}
          {secret.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {secret.map((item) => (
                <span
                  key={item.key}
                  className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  <KeyRound className="size-3" />
                  {item.key}: {item.value}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {status?.state === "connected" ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-500">
          <Check className="size-3.5" /> {t("mcpProposal.connected", { count: status.toolNames.length })}
        </p>
      ) : wasDiscarded && !status ? (
        <p className="text-xs text-muted-foreground">{t("mcpProposal.discarded")}</p>
      ) : !status ? (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={discard}>
            {t("mcpProposal.discard")}
          </Button>
          <Button size="sm" className="gap-1.5" disabled={busy !== null} onClick={() => void run("connect", connect)}>
            <Plug className="size-3.5" />
            {t("mcpProposal.connect")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {status.error && (
            <p className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 break-words">{t("mcpProposal.failed", { error: status.error })}</span>
            </p>
          )}
          {needsAuth(status) && !status.error && (
            <p className="text-xs text-amber-500">{t("mcpProposal.needsAuth")}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={busy !== null}
              onClick={() => void run("retry", () => mcpApi.reconnect(name))}
            >
              <RefreshCw className="size-3.5" />
              {busy === "retry" ? t("mcpProposal.retrying") : t("mcpProposal.retry")}
            </Button>
            {needsAuth(status) && (
              <Button
                size="sm"
                className="gap-1.5"
                disabled={busy !== null}
                onClick={() => void run("auth", () => mcpApi.auth(name))}
              >
                <KeyRound className="size-3.5" />
                {busy === "auth"
                  ? t("mcpProposal.authorizing")
                  : status.authorized
                    ? t("mcpProposal.reauthorize")
                    : t("mcpProposal.authorize")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
