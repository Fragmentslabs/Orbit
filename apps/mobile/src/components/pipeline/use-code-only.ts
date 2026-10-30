import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import { useWorkspaceStore } from '~/stores/workspace-store'

/**
 * Mode guard of the pipeline screens: the pipeline only exists in code mode
 * (the sidebar item is codeOnly) — if the mode changes with the screen open, go
 * back home instead of leaving the screen in a mode that does not have it.
 */
export function useCodeOnly() {
  const router = useRouter()
  const mode = useWorkspaceStore((s) => s.mode)

  useEffect(() => {
    if (mode !== 'code') router.replace('/(main)')
  }, [mode, router])
}
