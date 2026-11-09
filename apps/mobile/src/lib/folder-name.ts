/** Last segment of a folder path — the name the header and the pickers show. */
export function folderName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || path
}
