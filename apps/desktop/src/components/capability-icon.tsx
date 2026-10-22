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
 * Um ícone por família de capacidade. Existe para o catálogo continuar sendo
 * dado puro (sem JSX) e para a pill da tela inicial e a linha do painel
 * desenharem exatamente o mesmo símbolo.
 */
const ICONS: Record<CapabilityId, LucideIcon> = {
  // O canvas de design não é o artefato: aqui a marca é o quadro (artboard),
  // lá é o painel que abre pronto no chat.
  design: Frame,
  artifact: LayoutDashboard,
  document: FileText,
  presentation: Monitor,
  diagram: Workflow,
  motion: Clapperboard,
  vector: PenTool,
  photo: ImageIcon,
  video: Film,
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
