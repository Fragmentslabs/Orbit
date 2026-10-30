import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

/**
 * Switch on top of the base-ui primitive (same base as the rest of the design system).
 *
 * The thumb is positioned by `translate-x` calculated from the size of the
 * track, not by loose values: a number out of sync with the width
 * leaves the dot outside the track, which was the defect of the previous version
 * made by hand.
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
          // track 36px − 2×2px padding − 16px thumb = 16px of travel
          "translate-x-0 data-[checked]:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  )
}
