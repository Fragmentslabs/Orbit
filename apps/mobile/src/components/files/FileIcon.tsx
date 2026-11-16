import {
  Archive,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Music,
  Settings2,
} from 'lucide-react-native'
import { categoryOf, type FileCategory } from '~/lib/files'

const ICONS = {
  code: FileCode,
  markdown: FileText,
  data: FileJson,
  config: Settings2,
  text: FileText,
  image: FileImage,
  media: Music,
  archive: Archive,
  document: FileText,
  other: File,
} satisfies Record<FileCategory, typeof File>

export function FileIcon({
  name,
  isDirectory,
  open,
  size = 20,
  color,
}: {
  name: string
  isDirectory?: boolean
  open?: boolean
  size?: number
  color: string
}) {
  if (isDirectory) {
    const Dir = open ? FolderOpen : Folder
    return <Dir size={size} color={color} />
  }
  const Icon = ICONS[categoryOf(name)]
  return <Icon size={size} color={color} />
}
