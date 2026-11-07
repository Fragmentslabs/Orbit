import { useCallback, useEffect, useState } from "react"
import type { FragmentDetails } from "@shared/fragment-details"
import { fragmentApi } from "@/src/lib/ipc"

/** The numbers of the details panel, re-read whenever the fragment is rewritten or its grants change. */
export function useFragmentDetails(fragmentId: string): FragmentDetails | null {
  const [details, setDetails] = useState<FragmentDetails | null>(null)
  const read = useCallback(() => void fragmentApi.details(fragmentId).then(setDetails), [fragmentId])
  useEffect(() => {
    read()
    return fragmentApi.onUpdated((e) => e.fragmentId === fragmentId && read())
  }, [fragmentId, read])
  return details
}
