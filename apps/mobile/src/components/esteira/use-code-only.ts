import { useEffect } from 'react'
import { useRouter } from 'expo-router'
import { useWorkspaceStore } from '~/stores/workspace-store'

/**
 * Guarda de modo das telas de esteira: a esteira só existe no modo código
 * (item da sidebar é codeOnly) — se o modo mudar com a tela aberta, volta
 * para a home em vez de deixar a tela num modo que não a possui.
 */
export function useCodeOnly() {
  const router = useRouter()
  const mode = useWorkspaceStore((s) => s.mode)

  useEffect(() => {
    if (mode !== 'code') router.replace('/(main)')
  }, [mode, router])
}
