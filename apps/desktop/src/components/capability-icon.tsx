import {
  AudioLines,
  Clapperboard,
  Database,
  FileSignature,
  FileText,
  Film,
  Frame,
  Image as ImageIcon,
  LayoutDashboard,
  ListChecks,
  Mic,
  Minimize2,
  Monitor,
  PenTool,
  Phone,
  Repeat,
  ScrollText,
  Video,
  Workflow,
  type LucideIcon,
} from "lucide-react"

import type { CapabilityId } from "@/src/lib/capabilities"

/**
 * One icon per capability family. It exists so the catalog stays
 * pure data (no JSX) and so the start screen pill and the panel row
 * draw exactly the same symbol.
 */
const ICONS: Record<CapabilityId, LucideIcon> = {
  // The design canvas is not the artifact: here the mark is the board (artboard),
  // there it is the panel that opens ready in the chat.
  design: Frame,
  artifact: LayoutDashboard,
  document: FileText,
  presentation: Monitor,
  diagram: Workflow,
  motion: Clapperboard,
  vector: PenTool,
  photo: ImageIcon,
  video: Film,
  // Compressing is reducing — the same symbol at any screen size.
  compress: Minimize2,
  record: Video,
  docx: FileSignature,
  audio: AudioLines,
  transcript: ScrollText,
  voice: Phone,
  dictation: Mic,
  memory: Database,
  routine: Repeat,
  board: ListChecks,
}

export function CapabilityIcon({
  capability,
  className,
}: {
  capability: CapabilityId
  className?: string
}) {
  const Icon = ICONS[capability]
  return <Icon className={className} aria-hidden />
}
