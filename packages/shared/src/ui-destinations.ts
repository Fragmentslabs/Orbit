/**
 * Registro de DESTINOS do app: onde cada tela fica, em cada superfície.
 *
 * Existe para responder "onde fica isso?" com um dado só — não com o que o
 * modelo lembra da última vez. O bloco `nav` do orbit-ui (ver
 * orbit-ui.ts no desktop) carrega apenas um `id`; o rótulo do caminho é montado
 * na tela, com as mesmas chaves de i18n que a própria tela usa, então renomear
 * uma aba renomeia o cartão e nada fica desatualizado em silêncio.
 *
 * As duas superfícies não têm as mesmas telas: `voice`, `computer` e `overlay`
 * só existem no desktop. Quem consome deve checar `supportsSurface` e degradar
 * SEMPRE para uma explicação — nunca para um botão que não abre nada.
 *
 * Fatia atual: os destinos que são aba do SettingsDialog do desktop. As telas
 * que só existem no mobile (memórias, uso, ferramentas, rotinas…) entram aqui
 * quando o renderer do mobile passar a desenhar o bloco.
 */

/**
 * Abas do SettingsDialog do desktop.
 *
 * Fica aqui, e não no store, porque o registro precisa nomeá-las; `stores/
 * settings-ui.ts` reexporta este tipo, então uma aba nova quebra o typecheck
 * no mapa de rótulos em vez de virar um destino invisível.
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
  /** Id que o modelo manda no bloco `nav`. É contrato com o prompt: não renomeie. */
  id: string
  /** Aba do SettingsDialog no desktop. Ausente = a tela não existe lá. */
  desktop?: SettingsTab
  /** Onde a tela fica no celular. Ausente = não existe lá. */
  mobile?: MobileDestination
  /** A aba some nas outras plataformas (ver `visibleTabs` em settings-dialog). */
  desktopPlatforms?: readonly DesktopPlatform[]
  /** Como o usuário chama isso, em pt e en — é o que liga a pergunta ao destino. */
  keywords: readonly string[]
}

export interface MobileDestination {
  /** Rota do expo-router no formato que o app usa: "/(main)/providers". */
  path: string
  /**
   * Chave do título que a própria tela mostra ("providersScreen.title").
   * Guardada junto da rota para as duas não divergirem.
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

/** Busca por id, tolerante a caixa e espaço — o modelo escreve " Voice ". */
export function uiDestination(id: string): UiDestination | undefined {
  return byId.get(id.trim().toLowerCase())
}

/**
 * O destino existe nesta superfície? No desktop, uma aba restrita a certas
 * plataformas conta como inexistente nas outras: prometer "Configurações →
 * Computador" a quem está num Linux é o mesmo que mandar procurar o que não há.
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
 * Catálogo em texto para o system prompt: id, superfícies e sinônimos. Gerado
 * do registro para que o modelo nunca veja uma lista que o app já não tem.
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
