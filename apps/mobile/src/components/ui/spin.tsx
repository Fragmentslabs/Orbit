import type { ReactNode } from "react";
import { View } from "react-native";
import { Animated } from "react-native";

export function Spin({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  if (!active) return <>{children}</>
  return (
    <Animated.View style={{ transform: [{ rotate: '0deg' }] }}>
      {children}
    </Animated.View>
  );
}
