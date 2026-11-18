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
} from 'lucide-react-native'
import type { CapabilityId } from '@orbit/shared'

/** One icon per capability — the same symbols as the desktop, so the pill and the guide row match. */
const ICONS: Record<CapabilityId, LucideIcon> = {
  design: Frame,
  artifact: LayoutDashboard,
  document: FileText,
  presentation: Monitor,
  diagram: Workflow,
  motion: Clapperboard,
  vector: PenTool,
  photo: ImageIcon,
  video: Film,
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

export function CapabilityIcon({ capability, size = 16, color }: { capability: CapabilityId; size?: number; color: string }) {
  const Icon = ICONS[capability]
  return <Icon size={size} color={color} />
}
