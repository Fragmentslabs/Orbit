import { useEffect, useMemo } from "react"
import type { Memory } from "@shared/memory"
import { useMemoryStore } from "@/src/stores/memory-store"

/**
 * One memory from the index, loaded on demand.
 *
 * The Memories screen index may never have been loaded inside a
 * conversation — the citation chip is the first thing to ask for a memory. Without
 * initialize() here, every chip would be born "not found". It is idempotent:
 * if the index has already arrived, there is no new call.
 */
export function useMemoryById(id: string | undefined): Memory | undefined {
  const index = useMemoryStore((s) => s.index)
  const initialize = useMemoryStore((s) => s.initialize)
  const memory = useMemo(() => (id ? index.find((m) => m.id === id) : undefined), [index, id])

  useEffect(() => {
    if (id && !memory) void initialize()
  }, [id, memory, initialize])

  return memory
}
