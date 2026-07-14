import { codeToTokensBase, bundledLanguages, type BundledLanguage } from "shiki"

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ps1: "powershell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  xml: "xml",
  svg: "xml",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "docker",
  ini: "ini",
  env: "ini",
  txt: "text",
}

export function langForPath(filePath: string): BundledLanguage | "text" {
  const name = filePath.replace(/\\/g, "/").split("/").pop() ?? ""
  if (name.toLowerCase() === "dockerfile") return "docker"
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : ""
  const lang = EXT_TO_LANG[ext] ?? "text"
  return lang in bundledLanguages ? (lang as BundledLanguage) : "text"
}

export interface HighlightedToken {
  content: string
  color?: string
}

export async function highlightLines(
  code: string,
  filePath: string,
  theme: "dark" | "light",
): Promise<HighlightedToken[][] | null> {
  const lang = langForPath(filePath)
  if (lang === "text") return null
  try {
    return await codeToTokensBase(code, {
      lang,
      theme: theme === "dark" ? "github-dark" : "github-light",
    })
  } catch {
    return null
  }
}
