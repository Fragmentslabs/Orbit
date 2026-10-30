import { useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Shield, ShieldCheck, ShieldOff } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PermissionMode } from "@shared/chat"
import { usePermissionMode, usePermissionPrefs } from "@/src/stores/permission-prefs"

const MODE_ICON: Record<PermissionMode, typeof Shield> = {
  ask: Shield,
  approve: ShieldCheck,
  full: ShieldOff,
}

/** Autonomy of the open chat (`sessionId` absent = new chat, which becomes the
 *  default when choosing). Changing it here does not affect the other chats. */
export function PermissionModePicker({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const mode = usePermissionMode(sessionId)
  const setMode = usePermissionPrefs((s) => s.setMode)
  const Icon = MODE_ICON[mode]

  const modes = useMemo(() => [
    { id: "ask" as PermissionMode, label: t("permissions.ask"), description: t("permissions.askDescription") },
    { id: "approve" as PermissionMode, label: t("permissions.approve"), description: t("permissions.approveDescription") },
    { id: "full" as PermissionMode, label: t("permissions.full"), description: t("permissions.fullDescription") },
  ], [t])

  return (
    <Select value={mode} onValueChange={(value) => value && setMode(sessionId, value as PermissionMode)}>
      <SelectTrigger
        size="sm"
        className="h-7 gap-1 border-none bg-transparent px-1.5 text-xs hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
        title={t("permissions.title")}
      >
        <Icon className="size-3 text-foreground" />
        <SelectValue>{modes.find((m) => m.id === mode)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent side="top" sideOffset={4} align="start" alignItemWithTrigger={false} className="min-w-64 p-1.5">
        {modes.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            <div className="flex flex-col whitespace-normal">
              <span>{m.label}</span>
              <span className="text-xs text-muted-foreground">{m.description}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
