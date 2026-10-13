import { useEffect, useState } from "react"

/**
 * Microfones da máquina (`enumerateDevices`), atualizados quando um aparelho é
 * plugado ou tirado. É o que alimenta o seletor de microfone da aba de voz.
 *
 * Os pseudo-aparelhos do Chromium ("default" e, no Windows, "communications")
 * ficam de fora: o "Padrão do sistema" da tela já é o `micDeviceId: null`, e
 * repetir o mesmo microfone com outro nome só confunde.
 *
 * Sem permissão de microfone o Chromium devolve os aparelhos SEM rótulo — quem
 * mostra decide o nome de reserva (o índice serve).
 */

export interface AudioInput {
  deviceId: string
  /** Vazio quando o rótulo ainda não foi liberado pela permissão. */
  label: string
}

const PSEUDO_DEVICES = new Set(["default", "communications"])

async function listInputs(): Promise<AudioInput[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId && !PSEUDO_DEVICES.has(device.deviceId))
    .map((device) => ({ deviceId: device.deviceId, label: device.label }))
}

export function useAudioInputs(): AudioInput[] {
  const [inputs, setInputs] = useState<AudioInput[]>([])

  useEffect(() => {
    const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined
    if (!media?.enumerateDevices) return
    let alive = true
    const refresh = () => {
      void listInputs()
        .then((next) => {
          if (alive) setInputs(next)
        })
        .catch(() => undefined)
    }
    refresh()
    media.addEventListener?.("devicechange", refresh)
    return () => {
      alive = false
      media.removeEventListener?.("devicechange", refresh)
    }
  }, [])

  return inputs
}
