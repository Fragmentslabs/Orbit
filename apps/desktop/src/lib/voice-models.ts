import type { VoiceModelInfo, VoiceModelKind } from "@shared/voice"

/** Modelo de voz do catálogo (`@shared/voice`) com o tamanho já em MB. */
export interface VoiceModelView {
  id: string
  label: string
  /** Motor que consome o modelo: "supertonic" (TTS), "parakeet", "whisper". */
  engine: string
  kind: VoiceModelKind
  sizeMb: number | null
}

/**
 * Catálogo do main no que a tela mostra. O catálogo pode chegar vazio (canal
 * ainda não respondeu) — e o tamanho vem em bytes, que é o número que o
 * usuário decide antes de baixar.
 */
export function modelViews(models: VoiceModelInfo[] | null | undefined): VoiceModelView[] {
  if (!Array.isArray(models)) return []
  return models
    .filter((model) => !!model?.id)
    .map((model) => ({
      id: model.id,
      label: model.label || model.id,
      engine: model.engine ?? "",
      kind: model.kind,
      sizeMb: model.bytes > 0 ? model.bytes / (1024 * 1024) : null,
    }))
}

/** "1,2 GB" / "480 MB" — `null` quando o catálogo não informou o tamanho. */
export function formatSizeMb(sizeMb: number | null): string | null {
  if (sizeMb === null || !Number.isFinite(sizeMb) || sizeMb <= 0) return null
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`
  return `${Math.round(sizeMb)} MB`
}
