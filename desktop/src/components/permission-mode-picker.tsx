import { Shield, ShieldCheck, ShieldOff, Settings2 } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { PermissionMode } from "@shared/chat"
import { usePermissionPrefs } from "@/src/stores/permission-prefs"

/**
 * Dropdown de 3 estados do modo de permissões (barra do code-input) + atalho
 * (engrenagem) que abre as Settings direto na aba "Autonomia & Permissões".
 */

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

interface Props {
  /** Acionado pela engrenagem: recebe a aba a abrir, ou undefined p/ default. */
  onOpenSettings?: (tab: "autonomy") => void
}

export function PermissionModePicker({ onOpenSettings }: Props) {
  const mode = usePermissionPrefs((s) => s.mode)
  const setMode = usePermissionPrefs((s) => s.setMode)
  const Icon = MODE_ICON[mode]

  return (
    <div className="flex items-center gap-0.5">
      <Select value={mode} onValueChange={(value) => value && setMode(value as PermissionMode)}>
        <SelectTrigger
          size="sm"
          className="h-7 gap-1 border-none bg-transparent px-1.5 text-xs hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
          title="Modo de permissões"
        >
          <Icon className="size-3 text-foreground" />
          <SelectValue />
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
      {onOpenSettings && (
        <button
          type="button"
          title="Configurar níveis por modo"
          onClick={() => onOpenSettings("autonomy")}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Settings2 className="size-3" />
        </button>
      )}
    </div>
  )
}
