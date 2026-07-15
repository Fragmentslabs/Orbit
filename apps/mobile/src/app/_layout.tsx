import "../global.css";
import "../lib/icon-interop";

import { useEffect } from "react"
import { DarkTheme, Stack, ThemeProvider, useRouter } from "expo-router"
import { PortalHost } from "@rn-primitives/portal";
import * as SplashScreen from "expo-splash-screen";
import { Platform } from "react-native";
import { StatusBar } from "expo-status-bar";
import { colorScheme } from "nativewind";
import { useCompanion } from "../hooks/useCompanion";
import { useNotifications } from "../hooks/useNotifications";
import { useConnectionStore } from "../stores/connection-store";

SplashScreen.preventAutoHideAsync();

// Orbit é dark por padrão (mesmo design system do desktop).
// No web o set() só pode rodar no browser — durante o SSR do Expo Router
// (render em Node) não há document e a chamada lança erro.
if (Platform.OS !== "web") {
  colorScheme.set("dark");
} else if (typeof document !== "undefined") {
  colorScheme.set("dark");
  document.documentElement.classList.add("dark");
}

// Tema de navegação alinhado aos tokens (background/card/border do global.css)
const OrbitDarkTheme: typeof DarkTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: "hsl(240, 11%, 4%)",
    card: "hsl(240, 6%, 10%)",
    border: "hsl(240, 4%, 13%)",
    text: "hsl(0, 0%, 98%)",
    primary: "hsl(44, 100%, 47%)",
  },
};

export default function RootLayout() {
  const router = useRouter();
  const connection = useConnectionStore((s) => s.connection);

  // Inicializa o companion (auto-reconnect + event wiring)
  useCompanion();

  // Configura notificações locais reativas aos eventos WS
  useNotifications();

  // ─── Routing lógico baseado no estado de conexão ──────────────────────
  useEffect(() => {
    if (connection.status === "connected") {
      router.replace("/(main)");
    } else if (
      connection.status === "disconnected" ||
      connection.status === "connecting" ||
      connection.status === "authenticating"
    ) {
      router.replace("/(connection)");
    }
  }, [connection.status, router]);

  // Esconde splash screen quando o routing está pronto
  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  return (
    <ThemeProvider value={OrbitDarkTheme}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(connection)" />
        <Stack.Screen name="(main)" />
      </Stack>
      <PortalHost />
    </ThemeProvider>
  );
}
