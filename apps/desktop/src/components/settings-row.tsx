import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/**
 * Linha de configuração: ícone, título, descrição e o controle à direita —
 * o mesmo desenho dos toggles de notificação e de "Criar pastas".
 */
export function SettingRow({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:bg-accent/50">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{title}</p>
        <p className="text-[11px] leading-tight text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingSwitch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors ${
        checked ? "bg-primary" : "bg-input"
      }`}
    >
      <span
        className={`pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  )
}

/** Select de opções fixas. Os valores viajam como string (o Select é de string). */
export function SettingSelect<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    <Select value={value} onValueChange={(v) => v && onChange(v as T)}>
      <SelectTrigger className="min-w-40">
        <SelectValue>{(v) => options.find((o) => o.value === v)?.label ?? v}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
