import { useEffect, useState } from "react"

/**
 * The machine's microphones (`enumerateDevices`), refreshed when a device is
 * plugged in or removed. This is what feeds the microphone selector in the voice tab.
 *
 * Chromium's pseudo-devices ("default" and, on Windows, "communications")
 * are left out: the screen's "System default" is already `micDeviceId: null`, and
 * repeating the same microphone under another name only confuses.
 *
 * Without microphone permission Chromium returns the devices WITHOUT a label —
 * whoever displays them decides the fallback name (the index will do).
 */

export interface AudioInput {
  deviceId: string
  /** Empty when the label has not been released by the permission yet. */
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
