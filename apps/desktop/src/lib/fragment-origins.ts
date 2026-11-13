import type { FragmentManifest } from "@shared/fragments"
import type { FragmentProvenance } from "@shared/fragment-provenance"

/** The source filters of the fragments library. */
export type FragmentSource = "all" | "native" | "integration" | "imported" | "local"

/**
 * Fragments that SHIP with Orbit.
 *
 * The product does not ship one today; when it does, its id goes here and the gallery can
 * tell it apart without guessing from a name or a date. Nothing else creates this set.
 */
const BUILTIN_FRAGMENT_IDS = new Set<string>()

/**
 * Where a fragment came from, in the four buckets the library shows:
 * native (ships with Orbit), integration (arrived through an MCP), imported (a link, a
 * repository or a file) and local (created in this Orbit). A fragment with no provenance
 * record predates the record, and everything before import existed was created here.
 */
export function fragmentSource(
  fragment: FragmentManifest,
  provenance: FragmentProvenance | undefined,
): Exclude<FragmentSource, "all"> {
  if (BUILTIN_FRAGMENT_IDS.has(fragment.id)) return "native"
  if (!provenance || provenance.origin === "local") return "local"
  return provenance.arrival === "mcp" ? "integration" : "imported"
}
