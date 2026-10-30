import type { VoiceDownloadProgress, VoiceHardwareInfo, VoiceModelInfo, VoiceStatusSnapshot } from "@shared/voice"

/**
 * The renderer's bridge to main's voice channels (`voice:*`).
 *
 * Downloading, cancelling and removing models is main's job; here we only fire the action,
 * listen to the progress and read the catalog and the machine state. The synthesis
 * channels (`voice:tts:*`) do not go through here — the one that speaks is `use-speak`.
 *
 * `voice:status-changed` is the notice that the state changed (download, extraction,
 * removal, failure): whoever subscribes re-queries `voice:status` instead of trusting the
 * payload, which may come whole or only with what changed.
 */
export const voiceApi = {
  hardware: () => window.ipcRenderer.invoke("voice:hardware") as Promise<VoiceHardwareInfo>,
  models: () => window.ipcRenderer.invoke("voice:models") as Promise<VoiceModelInfo[]>,
  status: () => window.ipcRenderer.invoke("voice:status") as Promise<VoiceStatusSnapshot>,
  download: (modelId: string) => window.ipcRenderer.invoke("voice:download", { modelId }) as Promise<unknown>,
  cancelDownload: (modelId: string) =>
    window.ipcRenderer.invoke("voice:download-cancel", { modelId }) as Promise<unknown>,
  removeModel: (modelId: string) => window.ipcRenderer.invoke("voice:remove-model", { modelId }) as Promise<unknown>,
  /**
   * Warms up a dictation engine in the BACKGROUND: the response comes back right away and the
   * model load runs off the user's path. Idempotent — calling it
   * again only returns the work already in progress, so it can be fired whenever
   * the microphone shows up.
   */
  sttWarm: (input: { modelId?: string; engine?: string; threads?: number } = {}) =>
    window.ipcRenderer.invoke("voice:stt:warm", input) as Promise<unknown>,
  /**
   * Releases right away what the dictation engines loaded. It is what the panel calls
   * when TURNING OFF preloading: the RAM comes back right away, instead of on the idle
   * cycle. With a dictation in progress main postpones it, instead of tearing the model down.
   */
  sttRelease: () => window.ipcRenderer.invoke("voice:stt:release") as Promise<unknown>,
  onDownloadProgress: (listener: (progress: VoiceDownloadProgress) => void) => {
    const wrapper = window.ipcRenderer.on("voice:download-progress", (payload) =>
      listener(payload as VoiceDownloadProgress),
    )
    return () => window.ipcRenderer.off("voice:download-progress", wrapper)
  },
  /**
   * Voice state changed in main (download finished, extraction, removal, failure).
   * The payload is the new snapshot when it comes whole, but main may send only what
   * changed — treat the event as a signal and normalize with `parseVoiceStatus` /
   * `readTtsStatus`, which accept a map by id, a list and `installed`/`downloaded`.
   */
  onStatusChanged: (listener: (status: VoiceStatusSnapshot) => void) => {
    const wrapper = window.ipcRenderer.on("voice:status-changed", (payload) =>
      listener(payload as VoiceStatusSnapshot),
    )
    return () => window.ipcRenderer.off("voice:status-changed", wrapper)
  },
}
