import type { FragmentManifest } from "@shared/fragments"

/** What an "http" / "mcp" ask would allow, in words the person can check before clicking Allow. */
export function describeAccess(manifest: FragmentManifest, capability: string): string {
  if (capability === "http") return manifest.hosts.join(", ")
  if (capability === "mcp") return manifest.mcp.map((m) => `${m.server} (${m.tools.join(", ")})`).join("; ")
  return ""
}
