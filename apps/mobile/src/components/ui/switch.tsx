import * as SwitchPrimitive from "@rn-primitives/switch";
import { getThemeTokens } from "~/lib/theme-tokens";
import { useThemeStore } from "~/stores/theme-store";

/**
 * Switch com estilos explícitos (track 44×24, thumb 20×20).
 *
 * Não depende das variantes data-[state=*] do NativeWind: elas não eram
 * aplicadas no dev client e o track ficava transparente (só o thumb
 * aparecia, parecendo um círculo). As cores vêm dos tokens do tema.
 */
function Switch(props: React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>) {
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved));
  const ativo = !!props.checked;
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
        backgroundColor: ativo ? tokens.primary : tokens.mutedForeground,
        opacity: props.disabled ? 0.5 : 1,
      }}
    >
      <SwitchPrimitive.Thumb
        style={{
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: tokens.background,
          transform: [{ translateX: ativo ? 20 : 0 }],
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
