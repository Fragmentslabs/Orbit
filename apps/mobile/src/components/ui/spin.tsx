import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Animated, Easing } from "react-native";

export function Spin({
  active = true,
  children,
}: {
  active?: boolean;
  children: ReactNode;
}) {
  // useState com inicializador lazy, e não `useRef(new ...).current`: o valor
  // é igualmente estável, mas pode ser lido no render (a regra react-hooks/refs
  // proíbe ler ref aqui) e o Animated.Value é alocado UMA vez — com useRef o
  // argumento era reconstruído a cada render e descartado.
  const [rotationAnim] = useState(() => new Animated.Value(0));

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
