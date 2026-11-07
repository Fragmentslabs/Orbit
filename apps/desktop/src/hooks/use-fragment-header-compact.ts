import { useStacked } from "@/src/hooks/use-stacked"

/** Window width under which the fragment header moves reload and model into the actions menu. */
const COMPACT_BELOW_PX = 900

/**
 * Whether the app header is too narrow for every fragment control to sit in the open. The
 * title (left) and the actions (right) are separate header slots, so both ask the same
 * question here and agree on which controls moved.
 */
export function useFragmentHeaderCompact(): boolean {
  return useStacked(document.documentElement, COMPACT_BELOW_PX)
}
