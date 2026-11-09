import { useCallback, useRef, useState } from "react"
import { FRAGMENT_PACKAGE_EXTENSION, FRAGMENT_PACKAGE_LIMITS } from "@shared/fragment-package"
import type { FragmentImportErrorCode, FragmentImportPreview } from "@shared/fragment-package"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"

export type FragmentImportProblem = FragmentImportErrorCode | "not_orbitfrag" | "failed"

/**
 * Importing a `.orbitfrag`, from the file picker or a drop. The file is read here only to
 * hand its bytes to the main process, which verifies everything and holds the result; this
 * hook then shows the consent card and sends back the token — nothing is written before
 * `confirm`.
 */
export function useFragmentImport() {
  const [preview, setPreview] = useState<FragmentImportPreview | null>(null)
  const [problem, setProblem] = useState<FragmentImportProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  const start = useCallback(async (file: File) => {
    setProblem(null)
    if (!file.name.toLowerCase().endsWith(FRAGMENT_PACKAGE_EXTENSION)) return setProblem("not_orbitfrag")
    if (file.size > FRAGMENT_PACKAGE_LIMITS.archiveBytes) return setProblem("too_large")
    setBusy(true)
    try {
      const result = await fragmentApi.importPreview(file.name, new Uint8Array(await file.arrayBuffer()))
      if (result.ok) setPreview(result.preview)
      else setProblem(result.code)
    } catch {
      setProblem("failed")
    } finally {
      setBusy(false)
    }
  }, [])

  const pickFile = useCallback(() => {
    if (!input.current) {
      const el = document.createElement("input")
      el.type = "file"
      el.accept = FRAGMENT_PACKAGE_EXTENSION
      el.onchange = () => {
        const file = el.files?.[0]
        el.value = ""
        if (file) void start(file)
      }
      input.current = el
    }
    input.current.click()
  }, [start])

  const cancel = useCallback(() => {
    if (preview) void fragmentApi.importCancel(preview.token)
    setPreview(null)
  }, [preview])

  const confirm = useCallback(async () => {
    if (!preview) return
    setBusy(true)
    try {
      const result = await fragmentApi.importConfirm(preview.token)
      setPreview(null)
      if (!result.ok) return setProblem("failed")
      // Straight to the details, where the person reviews what it asks for.
      const state = useFragmentsStore.getState()
      await state.load()
      state.open(result.fragmentId)
      if (!useFragmentsStore.getState().detailsOpen) useFragmentsStore.getState().toggleDetails()
    } finally {
      setBusy(false)
    }
  }, [preview])

  return { preview, problem, busy, start, pickFile, cancel, confirm, dismissProblem: () => setProblem(null) }
}
