import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Animated, Easing } from "react-native";

export function Spin({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  const rotationAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;
    if (active) {
      rotationAnim.setValue(0);
      loop = Animated.loop(
        Animated.timing(rotationAnim, {
          toValue: 1,
          duration: 1000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      loop.start();
    }
    return () => {
      loop?.stop();
    };
  }, [active, rotationAnim]);

  const rotate = rotationAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"],
  });

  if (!active) return <>{children}</>;
  return (
    <Animated.View style={{ transform: [{ rotate }] }}>
      {children}
    </Animated.View>
  );
}
