import type { SettingsTab } from "@shared/ui-destinations"

/**
 * Rótulo de cada aba do SettingsDialog, por chave de i18n.
 *
 * Existe porque o rótulo da aba e o caminho mostrado no cartão de navegação do
 * chat (`nav` do orbit-ui) têm de ser o mesmo texto: duas listas de rótulos
 * divergem no primeiro rename. Note que `overlay` não mora em `settings.tabs` —
 * ele reaproveita o título do painel do overlay.
 */
export const SETTINGS_TAB_LABEL_KEY: Record<SettingsTab, string> = {
  providers: "settings.tabs.providers.label",
  autonomy: "settings.tabs.autonomy.label",
  "mcp-skills": "settings.tabs.mcp-skills.label",
  data: "settings.tabs.data.label",
  howto: "settings.tabs.howto.label",
  appearance: "settings.tabs.appearance.label",
  notifications: "settings.tabs.notifications.label",
  voice: "settings.tabs.voice.label",
  system: "settings.tabs.system.label",
  browser: "settings.tabs.browser.label",
  computer: "settings.tabs.computer.label",
  overlay: "overlaySettings.title",
  about: "settings.tabs.about.label",
}
