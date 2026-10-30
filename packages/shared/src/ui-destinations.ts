/**
 * Registry of DESTINATIONS of the app: where each screen is, on each surface.
 *
 * It exists to answer "where is this?" with a single datum — not with what the
 * model remembers from last time. The `nav` block of orbit-ui (see
 * orbit-ui.ts in the desktop) carries only an `id`; the label of the path is built
 * in the screen, with the same i18n keys the screen itself uses, so renaming
 * a tab renames the card and nothing falls silently out of date.
 *
 * The two surfaces do not have the same screens: `voice`, `computer` and `overlay`
 * only exist on the desktop. Whoever consumes it must check `supportsSurface` and degrade
 * ALWAYS to an explanation — never to a button that opens nothing.
 *
 * Current slice: the destinations that are tabs of the desktop SettingsDialog. The screens
 * that only exist on mobile (memories, usage, tools, routines…) come in here
 * when the mobile renderer starts drawing the block.
 */

/**
 * Tabs of the desktop SettingsDialog.
 *
 * It lives here, and not in the store, because the registry needs to name them; `stores/
 * settings-ui.ts` re-exports this type, so a new tab breaks the typecheck
 * on the label map instead of becoming an invisible destination.
 */
export type SettingsTab =
  | "providers"
  | "autonomy"
  | "mcp-skills"
  | "data"
  | "howto"
  | "appearance"
  | "notifications"
  | "voice"
  | "system"
  | "browser"
  | "computer"
  | "overlay"
  | "about"

export type AppSurface = "desktop" | "mobile"

export type DesktopPlatform = "darwin" | "win32" | "linux"

export interface UiDestination {
  /** Id the model sends in the `nav` block. It is a contract with the prompt: do not rename it. */
  id: string
  /** SettingsDialog tab on the desktop. Absent = the screen does not exist there. */
  desktop?: SettingsTab
  /** Where the screen is on the phone. Absent = it does not exist there. */
  mobile?: MobileDestination
  /** The tab disappears on the other platforms (see `visibleTabs` in settings-dialog). */
  desktopPlatforms?: readonly DesktopPlatform[]
  /** How the user calls it, in pt and en — it is what links the question to the destination. */
  keywords: readonly string[]
}

export interface MobileDestination {
  /** expo-router route in the format the app uses: "/(main)/providers". */
  path: string
  /**
   * Key of the title the screen itself shows ("providersScreen.title").
   * Kept next to the route so the two do not diverge.
   */
  titleKey: string
}

export const UI_DESTINATIONS: readonly UiDestination[] = [
  {
    id: "voice",
    desktop: "voice",
    keywords: [
      "voz",
      "voice",
      "tts",
      "texto em fala",
      "ler em voz alta",
      "leitura em voz alta",
      "ditado",
      "microfone",
      "transcrição",
      "voz do assistente",
    ],
  },
  {
    id: "providers",
    desktop: "providers",
    mobile: { path: "/(main)/providers", titleKey: "providersScreen.title" },
    keywords: [
      "provedor",
      "provedores",
      "provider",
      "chave de api",
      "api key",
      "credencial",
      "modelo",
      "modelos",
      "endpoint",
      "openai",
      "anthropic",
      "gemini",
      "groq",
      "openrouter",
    ],
  },
  {
    id: "preferences",
    desktop: "autonomy",
    mobile: { path: "/(main)/preferences", titleKey: "preferencesScreen.title" },
    keywords: [
      "preferências",
      "preferences",
      "modelo padrão",
      "modelos padrão",
      "autonomia",
      "modos ativos",
      "memória",
      "memórias",
      "contexto",
    ],
  },
  {
    id: "appearance",
    desktop: "appearance",
    mobile: { path: "/(main)/appearance", titleKey: "appearanceScreen.title" },
    keywords: ["aparência", "appearance", "tema", "theme", "cor", "cores", "fonte", "densidade", "claro", "escuro"],
  },
  {
    id: "notifications",
    desktop: "notifications",
    mobile: { path: "/(main)/notifications", titleKey: "notificationsScreen.title" },
    keywords: ["notificação", "notificações", "notification", "aviso", "avisos", "som", "alerta", "segundo plano"],
  },
  {
    id: "howto",
    desktop: "howto",
    mobile: { path: "/(main)/howto", titleKey: "howtoScreen.title" },
    keywords: ["como funciona", "how it works", "ajuda", "help", "atalho", "atalhos", "combinações", "tutorial", "manual"],
  },
  {
    id: "about",
    desktop: "about",
    mobile: { path: "/(main)/about", titleKey: "aboutScreen.title" },
    keywords: ["sobre", "about", "versão", "version", "créditos", "atualização", "update", "apoiar", "beta"],
  },
  {
    id: "browser",
    desktop: "browser",
    keywords: ["navegador", "browser", "navegação", "site", "página", "web"],
  },
  {
    id: "computer",
    desktop: "computer",
    desktopPlatforms: ["darwin", "win32"],
    keywords: [
      "computador",
      "computer",
      "computer use",
      "controle do computador",
      "controlar o computador",
      "ver a tela",
      "mouse",
      "clicar",
      "operar outro app",
    ],
  },
  {
    id: "overlay",
    desktop: "overlay",
    keywords: ["overlay", "atalho global", "atalho", "barra flutuante", "modo chamada", "perguntar rápido", "shift espaço"],
  },
  {
    id: "system",
    desktop: "system",
    desktopPlatforms: ["win32"],
    keywords: ["sistema", "system", "abrir com orbit", "explorer", "integração com o sistema"],
  },
  {
    id: "data",
    desktop: "data",
    keywords: ["dados", "data", "exportar", "importar", "backup", "apagar tudo", "histórico", "privacidade"],
  },
]

const byId = new Map(UI_DESTINATIONS.map((destination) => [destination.id, destination]))

/** Search by id, tolerant to case and spaces — the model writes " Voice ". */
export function uiDestination(id: string): UiDestination | undefined {
  return byId.get(id.trim().toLowerCase())
}

/**
 * Does the destination exist on this surface? On the desktop, a tab restricted to certain
 * platforms counts as nonexistent on the others: promising "Settings →
 * Computer" to someone on Linux is the same as sending them after what is not there.
 */
export function supportsSurface(
  destination: UiDestination,
  surface: AppSurface,
  platform?: DesktopPlatform,
): boolean {
  if (surface === "mobile") return Boolean(destination.mobile)
  if (!destination.desktop) return false
  if (!destination.desktopPlatforms) return true
  return platform !== undefined && destination.desktopPlatforms.includes(platform)
}

/**
 * Catalog in text for the system prompt: id, surfaces and synonyms. Generated
 * from the registry so the model never sees a list the app no longer has.
 */
export function uiDestinationCatalog(): string {
  return UI_DESTINATIONS.map((destination) => {
    const surfaces =
      destination.desktop && destination.mobile
        ? "desktop+mobile"
        : destination.desktop
          ? "desktop only"
          : "mobile only"
    return `${destination.id} [${surfaces}] — ${destination.keywords.slice(0, 6).join(", ")}`
  }).join("\n")
}
