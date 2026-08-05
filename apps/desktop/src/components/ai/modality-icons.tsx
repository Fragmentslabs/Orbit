import { FileText, Image as ImageIcon, Mic, Video } from "lucide-react"

/**
 * Ícones das modalidades de entrada não-texto (image/audio/video/pdf).
 * "text" é omitido — todo modelo aceita texto.
 */

const MODALITY_ICONS: Record<string, typeof Mic> = {
  image: ImageIcon,
  audio: Mic,
  video: Video,
  pdf: FileText,
}

const MODALITY_ORDER = ["image", "audio", "video", "pdf"]

export function ModalityIcons({
  modalities,
  className,
}: {
  modalities?: string[]
  className?: string
}) {
  if (!modalities) return null
  return (
    <>
      {MODALITY_ORDER.filter((m) => modalities.includes(m)).map((m) => {
        const Icon = MODALITY_ICONS[m]
        return Icon ? <Icon key={m} className={className} aria-label={m} /> : null
      })}
    </>
  )
}
