import type { VoiceModelInfo, VoiceModelKind } from "@shared/voice"

/** Voice model from the catalog (`@shared/voice`) with the size already in MB. */
export interface VoiceModelView {
  id: string
  label: string
  /** Engine that consumes the model: "supertonic" (TTS), "parakeet", "whisper". */
  engine: string
  kind: VoiceModelKind
  sizeMb: number | null
}

/**
 * Main's catalog reduced to what the screen shows. The catalog may arrive empty (the channel
 * has not answered yet) — and the size comes in bytes, which is the number the
 * user decides on before downloading.
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

/** "1.2 GB" / "480 MB" — `null` when the catalog did not report the size. */
export function formatSizeMb(sizeMb: number | null): string | null {
  if (sizeMb === null || !Number.isFinite(sizeMb) || sizeMb <= 0) return null
  if (sizeMb >= 1024) return `${(sizeMb / 1024).toFixed(1)} GB`
  return `${Math.round(sizeMb)} MB`
}
