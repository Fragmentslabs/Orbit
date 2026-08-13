import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

/**
 * Switch sobre o primitivo do base-ui (mesma base do resto do design system).
 *
 * O thumb é posicionado por `translate-x` calculado a partir do tamanho da
 * trilha, não por valores soltos: um número fora de sincronia com a largura
 * deixa a bolinha para fora da trilha, que foi o defeito da versão anterior
 * feita à mão.
 */
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors outline-none",
        "bg-muted-foreground/30 data-[checked]:bg-primary",
        "focus-visible:ring-2 focus-visible:ring-ring/40",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "block size-4 rounded-full bg-background shadow-sm transition-transform",
          // trilha 36px − padding 2×2px − thumb 16px = 16px de curso
          "translate-x-0 data-[checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  )
}
