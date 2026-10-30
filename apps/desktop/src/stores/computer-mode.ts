import { isComputerPlatform } from "@shared/computer"
import { windowApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"
import { useModeActive } from "@/src/stores/mode-overrides"

/**
 * Computer mode of the conversation: two keys. The Preferences switch
 * decides whether the mode shows up; the conversation toggle decides whether it applies in this chat —
 * and it starts off in every new chat (there is no global default for it).
 */
export function useComputerMode(sessionId?: string | null): { visible: boolean; active: boolean } {
  const enabled = useAppSettings((s) => s.settings.computer.enabled)
  const visible = enabled && isComputerPlatform(windowApi.platform)
  const active = useModeActive("computer", sessionId, false)
  return { visible, active: visible && active }
}
