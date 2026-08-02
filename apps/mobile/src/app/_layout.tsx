import "../global.css";
import "../i18n";

import { useEffect, useMemo } from "react"
import { Appearance, useColorScheme } from "react-native"
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router"
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { PortalHost } from "@rn-primitives/portal";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCompanion } from "../hooks/useCompanion";
import { useNotifications } from "../hooks/useNotifications";
import { useConnectionStore } from "../stores/connection-store";
import { useNotificationPrefsStore } from "../stores/notification-prefs-store";
import { useSessionStore } from "../stores/session-store";
import { useThemeStore, hydrateThemePreference } from "../stores/theme-store";
import { useAppearanceStore, hydratePersonaVisible } from "../stores/appearance-store";
import { useLocaleStore, hydrateLocale } from "../stores/locale-store";
import { startMessageScheduler } from "../stores/message-queue-store";

SplashScreen.preventAutoHideAsync();

// ─── Navigation themes ─────────────────────────────────────────────────────

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

const OrbitLightTheme: typeof DefaultTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: "hsl(0, 0%, 100%)",
    card: "hsl(0, 0%, 100%)",
    border: "hsl(240, 4%, 90%)",
    text: "hsl(240, 10%, 4%)",
    primary: "hsl(44, 100%, 70%)",
  },
};

export default function RootLayout() {
  const router = useRouter();
  const connection = useConnectionStore((s) => s.connection);
  const systemScheme = useColorScheme();
  const systemIsDark = systemScheme !== "light";
  const resolved = useThemeStore((s) => s.resolved);
  const setPreference = useThemeStore((s) => s.setPreference);

  // Hidrata tema e persona persistidos ao montar
  useEffect(() => {
    hydrateThemePreference().then((pref) => {
      setPreference(pref, systemIsDark);
      Appearance.setColorScheme(pref === "system" ? (systemIsDark ? "dark" : "light") : pref);
    });
    hydratePersonaVisible().then((visible) => {
      useAppearanceStore.getState().setPersonaVisible(visible);
    });
    hydrateLocale().then((locale) => {
      useLocaleStore.getState().setLocale(locale);
    });
  }, []);

  // Sincroniza mudanças do theme-store com o Appearance API (NativeWind v5)
  useEffect(() => {
    Appearance.setColorScheme(resolved);
  }, [resolved]);

  // Sincroniza mudança de scheme do SO quando preference é "system"
  useEffect(() => {
    const pref = useThemeStore.getState().preference;
    if (pref === "system") {
      setPreference("system", systemIsDark);
      Appearance.setColorScheme(systemIsDark ? "dark" : "light");
    }
  }, [systemIsDark]);

  const navTheme = useMemo(
    () => (resolved === "dark" ? OrbitDarkTheme : OrbitLightTheme),
    [resolved],
  );

  // Inicializa o companion (auto-reconnect + event wiring)
  useCompanion();

  // Configura notificações locais reativas aos eventos WS
  useNotifications();

  const loadingConfig = useConnectionStore((s) => s.loadingConfig);
  const config = useConnectionStore((s) => s.config);

  // ─── Routing lógico baseado no estado de conexão ──────────────────────
  useEffect(() => {
    if (connection.status === "connected") {
      router.replace("/(main)");
    } else if (!loadingConfig && connection.status === "disconnected") {
      // Só decide rota depois que o loadConfig() terminou
      if (connection.error || !config) {
        router.replace("/(connection)");
      }
      // Se tem config mas deu erro, a tela de conexão mostra o erro
    }
  }, [connection.status, connection.error, loadingConfig, config, router]);

  // Esconde splash só depois da decisão de rota inicial
  useEffect(() => {
    if (!loadingConfig) {
      SplashScreen.hideAsync();
    }
  }, [loadingConfig]);

  useEffect(() => {
    startMessageScheduler();
    void useNotificationPrefsStore.getState().loadPrefs();
    // Carrega cache de sessões para aparecerem imediatamente
    // (o fetch real via WS acontece quando conectar)
    void useSessionStore.getState().fetchSessions();
  }, []);

  // Enquanto carrega config, não renderiza nada (splash visível)
  if (loadingConfig && connection.status !== "connected") {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <KeyboardProvider>
        <ThemeProvider value={navTheme}>
          <StatusBar style={resolved === "dark" ? "light" : "dark"} />
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(connection)" />
            <Stack.Screen name="(main)" />
          </Stack>
          <PortalHost />
        </ThemeProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}
