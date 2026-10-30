import type { SettingsTab } from "@shared/ui-destinations"

/**
 * Label of each SettingsDialog tab, by i18n key.
 *
 * It exists because the tab label and the path shown in the chat's navigation
 * card (orbit-ui's `nav`) have to be the same text: two label lists
 * diverge on the first rename. Note that `overlay` does not live in `settings.tabs` —
 * it reuses the overlay panel's title.
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
