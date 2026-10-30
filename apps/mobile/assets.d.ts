/**
 * Assets that are not images have no type for TypeScript: Metro registers them
 * and `require`/`import` returns the numeric id, which `expo-asset` turns into a
 * file. Without this declaration the import of the mermaid bundle does not compile.
 */
declare module '*.txt' {
  const asset: number
  export default asset
}
