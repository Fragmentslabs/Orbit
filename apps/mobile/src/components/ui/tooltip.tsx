import * as TooltipPrimitive from "@rn-primitives/tooltip";
import { cn } from "~/lib/utils";

function Tooltip({
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={300} {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Content
      sideOffset={sideOffset}
      className={cn(
        "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95",
        className
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
