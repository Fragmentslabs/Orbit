import { Platform } from "react-native";
import * as SwitchPrimitive from "@rn-primitives/switch";
import { cssInterop } from "nativewind";
import { cn } from "~/lib/utils";

cssInterop(SwitchPrimitive.Root, { className: "style" });
cssInterop(SwitchPrimitive.Thumb, { className: "style" });

function Switch({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "peer flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent",
        "web:cursor-pointer web:transition-colors",
        "data-[state=checked]:bg-primary data-[state=unchecked]:bg-input",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none rounded-full bg-background shadow-lg ring-0",
          "h-5 w-5",
          "data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
