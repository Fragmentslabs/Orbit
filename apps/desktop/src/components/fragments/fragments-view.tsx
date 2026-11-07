import { useEffect } from "react"
import { setFragmentClaimer } from "@/src/stores/panel-store"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentCreate } from "./fragment-create"
import { FragmentGallery } from "./fragment-gallery"
import { FragmentScreen } from "./fragment-screen"

/**
 * The Fragments page (sidebar). Three states, one at a time:
 *
 *   gallery  →  [new]  →  creation (empty canvas with the prompt in the middle)
 *      ↑                        │ the agent builds it live; when it exists:
 *      └──── [back] ←── fragment screen (header, live frame, edit mode)
 *
 * While the page is mounted it takes over the "fragment" events of the fragment it
 * shows (or is creating), so the same fragment is not also opened as a side-panel tab.
 */
export function FragmentsView() {
  const activeId = useFragmentsStore((s) => s.activeId)
  const composing = useFragmentsStore((s) => s.composing)
  const creating = useFragmentsStore((s) => s.creating)
  const load = useFragmentsStore((s) => s.load)

  useEffect(() => {
    void load()
    setFragmentClaimer((event) => useFragmentsStore.getState().claim(event))
    return () => {
      setFragmentClaimer(null)
      // A creation left behind keeps running in its chat; its result opens as a panel tab.
      useFragmentsStore.setState({ creating: null, composing: false })
    }
  }, [load])

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
      {activeId ? (
        <FragmentScreen key={activeId} fragmentId={activeId} />
      ) : composing || creating ? (
        <FragmentCreate />
      ) : (
        <FragmentGallery />
      )}
    </div>
  )
}
