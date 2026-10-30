import * as SwitchPrimitive from "@rn-primitives/switch";
import { getThemeTokens } from "~/lib/theme-tokens";
import { useThemeStore } from "~/stores/theme-store";

/**
 * Switch with explicit styles (track 44×24, thumb 20×20).
 *
 * It does not rely on the data-[state=*] variants of NativeWind: they were not
 * applied in the dev client and the track stayed transparent (only the thumb
 * showed up, looking like a circle). The colors come from the theme tokens.
 */
function Switch(props: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));
  const active = !!props.checked;
  const { style: _style, ...rest } = props;
  return (
    <SwitchPrimitive.Root
      {...rest}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        paddingHorizontal: 2,
        justifyContent: "center",
        backgroundColor: active ? tokens.primary : tokens.mutedForeground,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <SwitchPrimitive.Thumb
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: tokens.background,
          transform: [{ translateX: active ? 20 : 0 }],
          shadowColor: "#000",
          shadowOpacity: 0.25,
          shadowRadius: 2,
          shadowOffset: { width: 0, height: 1 },
          elevation: 2,
        }}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
