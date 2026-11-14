import { AlignLeft, BrainCircuit, Eye, FileText, Globe, Users, type LucideIcon } from "lucide-react"
import type { TFunction } from "i18next"
import type { PermissionMode } from "@shared/chat"
import type { ChatModeKey } from "@shared/companion"
import type { ModeToggleDef } from "@/src/components/mode-menu-items"
import type { SlashCommand } from "@/src/components/slash-palette"
import type { ComposerKind } from "@/src/lib/remote-composer-state"
import { REMOTE_MODES } from "@/src/lib/remote-composer-state"

/**
 * The mode toggles and "/" commands of the composer of another desktop. They are the same
 * labels the local composers use (same i18n keys) over the modes the companion API can set
 * on that machine; what it cannot (fragments, MCP, skills, hooks, orchestra, loop) is not here.
 */

interface ModeLook {
  icon: LucideIcon
  label: (kind: ComposerKind, t: TFunction) => string
  description: (kind: ComposerKind, t: TFunction) => string
  keywords: string[]
}

const LOOKS: Record<string, ModeLook> = {
  search: {
    icon: Globe,
    label: (kind, t) => t(kind === "chat" ? "input.modes.web.label" : "input.modes.search.label"),
    description: (kind, t) => t(kind === "chat" ? "input.slash.webDescription" : "codeInput.slash.searchDescription"),
    keywords: ["web", "search", "browser"],
  },
  plan: {
    icon: FileText,
    label: (_k, t) => t("codeInput.modes.plan.label"),
    description: (_k, t) => t("codeInput.slash.planDescription"),
    keywords: ["plan", "reading"],
  },
  simple: {
    icon: AlignLeft,
    label: (_k, t) => t("input.modes.simple.label"),
    description: (_k, t) => t("input.slash.simpleDescription"),
    keywords: ["plain", "text"],
  },
  brain: {
    icon: BrainCircuit,
    label: (_k, t) => t("input.slash.brainLabel"),
    description: (kind, t) => t(kind === "chat" ? "input.slash.brainDescription" : "codeInput.slash.brainDescription"),
    keywords: ["memory", "brain"],
  },
  subagents: {
    icon: Users,
    label: (_k, t) => t("codeInput.slash.subagentsLabel"),
    description: (_k, t) => t("codeInput.slash.subagentsDescription"),
    keywords: ["worker", "delegate"],
  },
  vision: {
    icon: Eye,
    label: (_k, t) => t("input.modes.vision.label"),
    description: (_k, t) => t("input.modes.vision.description"),
    keywords: ["vision", "image"],
  },
}

export type RemoteModeToggle = ModeToggleDef & { key: ChatModeKey; description: string }

export function remoteModeToggles(kind: ComposerKind, active: Record<string, boolean>, setMode: (mode: ChatModeKey, value: boolean) => void, t: TFunction): RemoteModeToggle[] {
  return REMOTE_MODES[kind].map((key) => ({
    key,
    icon: LOOKS[key].icon,
    label: LOOKS[key].label(kind, t),
    description: LOOKS[key].description(kind, t),
    active: !!active[key],
    onChange: (value: boolean) => setMode(key, value),
  }))
}

const PERMISSIONS: { id: PermissionMode; label: string; description: string }[] = [
  { id: "ask", label: "codeInput.slash.permAsk", description: "codeInput.slash.permAskDescription" },
  { id: "approve", label: "codeInput.slash.permApprove", description: "codeInput.slash.permApproveDescription" },
  { id: "full", label: "codeInput.slash.permFull", description: "codeInput.slash.permFullDescription" },
]

export function remoteSlashCommands(opts: {
  kind: ComposerKind
  active: Record<string, boolean>
  permission: PermissionMode
  setMode: (mode: ChatModeKey, value: boolean) => void
  setPermission: (mode: PermissionMode) => void
  actions: SlashCommand[]
  t: TFunction
}): SlashCommand[] {
  const { kind, active, permission, setMode, setPermission, actions, t } = opts
  const done = (fn: () => void) => ({ setText }: { setText: (text: string) => void }) => {
    fn()
    setText("")
  }
  const modes = REMOTE_MODES[kind].map((key): SlashCommand => ({
    id: key,
    label: LOOKS[key].label(kind, t),
    description: LOOKS[key].description(kind, t),
    keywords: LOOKS[key].keywords,
    group: "Modes",
    active: !!active[key],
    run: done(() => setMode(key, !active[key])),
  }))
  const permissions =
    kind === "code"
      ? PERMISSIONS.map((p): SlashCommand => ({
          id: `permission-${p.id}`,
          label: t("codeInput.slash.permissionLabel", { label: t(p.label) }),
          description: t(p.description),
          keywords: ["permission", "autonomy", p.id],
          group: "Modes",
          active: permission === p.id,
          run: done(() => setPermission(p.id)),
        }))
      : []
  return [...modes, ...actions, ...permissions]
}
