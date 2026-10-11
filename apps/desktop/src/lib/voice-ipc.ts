import type { VoiceDownloadProgress, VoiceHardwareInfo, VoiceModelInfo, VoiceStatusSnapshot } from "@shared/voice"

/**
 * Ponte do renderer com os canais de voz do main (`voice:*`).
 *
 * Baixar, cancelar e remover modelos é do main; aqui só disparamos a ação,
 * escutamos o progresso e lemos o catálogo e o estado da máquina. Os canais de
 * síntese (`voice:tts:*`) não passam por aqui — quem fala é o `use-speak`.
 *
 * `voice:status-changed` é o aviso de que o estado mudou (download, extração,
 * remoção, falha): quem assina reconsulta o `voice:status` em vez de confiar no
 * payload, que pode vir inteiro ou só com o que mudou.
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
   * Aquece um motor de ditado em SEGUNDO PLANO: a resposta volta na hora e a
   * carga do modelo corre fora do caminho do usuário. Idempotente — chamar de
   * novo só devolve o trabalho já em andamento, então pode ser disparado sempre
   * que o microfone aparece.
   */
  sttWarm: (input: { modelId?: string; engine?: string; threads?: number } = {}) =>
    window.ipcRenderer.invoke("voice:stt:warm", input) as Promise<unknown>,
  onDownloadProgress: (listener: (progress: VoiceDownloadProgress) => void) => {
    const wrapper = window.ipcRenderer.on("voice:download-progress", (payload) =>
      listener(payload as VoiceDownloadProgress),
    )
    return () => window.ipcRenderer.off("voice:download-progress", wrapper)
  },
  /**
   * Estado de voz mudou no main (download concluído, extração, remoção, falha).
   * O payload é o retrato novo quando vem inteiro, mas o main pode mandar só o
   * que mudou — trate o evento como sinal e normalize com `parseVoiceStatus` /
   * `readTtsStatus`, que aceitam mapa por id, lista e `installed`/`downloaded`.
   */
  onStatusChanged: (listener: (status: VoiceStatusSnapshot) => void) => {
    const wrapper = window.ipcRenderer.on("voice:status-changed", (payload) =>
      listener(payload as VoiceStatusSnapshot),
    )
    return () => window.ipcRenderer.off("voice:status-changed", wrapper)
  },
}
