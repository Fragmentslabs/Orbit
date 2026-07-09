import { Brain } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ModelVariant } from "@/shared/chat"

/**
 * Dropdown de nível de thinking (abre para cima), visível somente quando o
 * thinking está ativo e o modelo expõe variants.
 */
export function ReasoningPicker({
  variants,
  selected,
  onSelect,
}: {
  variants: ModelVariant[]
  selected: string | undefined
  onSelect: (variantId: string) => void
}) {
  if (variants.length === 0) return null

  return (
    <Select value={selected ?? null} onValueChange={(value) => value && onSelect(value as string)}>
      <SelectTrigger
        size="sm"
        className="h-7 gap-1 border-none bg-transparent px-1.5 text-xs hover:bg-muted dark:bg-transparent dark:hover:bg-muted"
      >
        <Brain className="size-3 text-foreground" />
        <SelectValue placeholder="Nível" />
      </SelectTrigger>
      <SelectContent side="top" sideOffset={4} align="start" alignItemWithTrigger={false}>
        {variants.map((variant) => (
          <SelectItem key={variant.id} value={variant.id}>
            {variant.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
