import { windowApi } from "@/src/lib/ipc"
import { useAppSettings } from "@/src/stores/app-settings"
import { useModeActive } from "@/src/stores/mode-overrides"

/**
 * Modo Computador da conversa: duas chaves. O interruptor das Preferências
 * decide se o modo aparece; o toggle da conversa decide se vale neste chat —
 * e começa desligado em todo chat novo (não há padrão global para isto).
 */
export function useComputerMode(sessionId?: string | null): { visible: boolean; active: boolean } {
  const enabled = useAppSettings((s) => s.settings.computer.enabled)
  const visible = enabled && windowApi.platform === "darwin"
  const active = useModeActive("computer", sessionId, false)
  return { visible, active: visible && active }
}
