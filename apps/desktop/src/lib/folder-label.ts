/** The last segment of a folder path from another machine (it may use either separator). */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}
