import { AudioLines, Clapperboard, CodeXml, Film, FileText, ImageIcon, LayoutGrid, Presentation } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { MediaKind } from "@shared/media"

/**
 * The icon of each type, in a single place: it is the SAME drawing in the tile badge and in the
 * filter chip, and that is what makes the filter look like a filter of what one sees
 * in the grid. A type missing in an old record counts as "image" (see mediaKind).
 */
export const KIND_ICON: Record<MediaKind, LucideIcon> = {
  image: ImageIcon,
  artifact: CodeXml,
  document: FileText,
  audio: AudioLines,
  motion: Clapperboard,
  video: Film,
  design: LayoutGrid,
  slides: Presentation,
}
