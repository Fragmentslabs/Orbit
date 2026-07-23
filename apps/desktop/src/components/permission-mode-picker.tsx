import { Shield, ShieldCheck, ShieldOff } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PermissionMode } from "@shared/chat"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"

const MODES: Array<{ id: PermissionMode; label: string; description: string }> = [
  { id: "ask", label: "Perguntar", description: "Confirma ações sensíveis antes de executar" },
  { id: "approve", label: "Autonomia", description: "Executa sozinho; ações críticas pedem confirmação" },
  { id: "full", label: "Irrestrito", description: "Sem perguntas (piso de segurança mantido)" },
]

const MODE_ICON: Record<PermissionMode, typeof Shield> = {
  ask: Shield,
  approve: ShieldCheck,
  full: ShieldOff,
}

export function PermissionModePicker() {
  const mode = usePermissionPrefs((s) => s.mode)
  const setMode = usePermissionPrefs((s) => s.setMode)
  const Icon = MODE_ICON[mode]

  return (
    <Select value={mode} onValueChange={(value) => value && setMode(value as PermissionMode)}>
      <SelectTrigger
        size="sm"
        className="h-7 gap-1 border-none bg-transparent px-1.5 text-xs hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
        title="Modo de permissões"
      >
        <Icon className="size-3 text-foreground" />
        <SelectValue>{MODES.find((m) => m.id === mode)?.label}</SelectValue>
      </SelectTrigger>
      <SelectContent side="top" sideOffset={4} align="start" alignItemWithTrigger={false} className="min-w-64 p-1.5">
        {MODES.map((m) => (
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
