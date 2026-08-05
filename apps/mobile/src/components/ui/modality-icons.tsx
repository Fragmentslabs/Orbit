import { FileText, Image as ImageIcon, Mic, Video } from 'lucide-react-native'

/**
 * Ícones das modalidades de entrada não-texto (image/audio/video/pdf).
 * "text" é omitido — todo modelo aceita texto.
 */

const ICONS = {
  image: ImageIcon,
  audio: Mic,
  video: Video,
  pdf: FileText,
} as const

const ORDER = ['image', 'audio', 'video', 'pdf'] as const

export function ModalityIcons({
  modalities,
  size,
  color,
}: {
  modalities?: string[]
  size?: number
  color?: string
}) {
  if (!modalities) return null
  return (
    <>
      {ORDER.filter((m) => modalities.includes(m)).map((m) => {
        const Icon = ICONS[m]
        return <Icon key={m} size={size ?? 13} color={color} style={{ marginRight: 2 }} />
      })}
    </>
  )
}
