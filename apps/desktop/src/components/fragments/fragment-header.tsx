import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeft } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/hint"
import { useFragment } from "@/src/components/fragment-tab"
import { fragmentApi } from "@/src/lib/ipc"
import { useFragmentsStore } from "@/src/stores/fragments-store"
import { FragmentIcon } from "./fragment-icon"
import { FragmentIconPicker } from "./fragment-icon-picker"

/**
 * What the app header shows while a fragment is open: back arrow, the fragment's icon
 * (click to change it) and its name (click to rename). The screen below carries no
 * header of its own — the fragment gets the whole area.
 */
export function FragmentHeaderTitle({ fragmentId }: { fragmentId: string }) {
  const { t } = useTranslation()
  const { manifest } = useFragment(fragmentId)
  const leave = useFragmentsStore((s) => s.leave)
  const [pickingIcon, setPickingIcon] = useState(false)

  if (!manifest) return null

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Hint label={t("fragments.back")}>
        <button
          type="button"
          onClick={leave}
          aria-label={t("fragments.back")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </button>
      </Hint>
      <Hint label={t("fragments.changeIcon")}>
        <button
          type="button"
          onClick={() => setPickingIcon(true)}
          aria-label={t("fragments.changeIcon")}
          className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors hover:bg-primary/20"
        >
          <FragmentIcon name={manifest.icon} className="size-4" />
        </button>
      </Hint>
      <NameField fragmentId={manifest.id} name={manifest.name} />
      <FragmentIconPicker open={pickingIcon} onOpenChange={setPickingIcon} fragmentId={manifest.id} current={manifest.icon} />
    </div>
  )
}

/** The name: click to turn it into an input (Enter saves, Esc cancels). */
function NameField({ fragmentId, name }: { fragmentId: string; name: string }) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== name) void fragmentApi.update(fragmentId, { name: next })
    else setDraft(name)
  }

  if (editing) {
    return (
      <Input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit()
          if (e.key === "Escape") {
            setDraft(name)
            setEditing(false)
          }
        }}
        className="h-7 w-56 text-sm"
        aria-label={t("fragments.rename")}
      />
    )
  }
  return (
    <Hint label={t("fragments.rename")}>
      <button
        type="button"
        onClick={() => {
          setDraft(name)
          setEditing(true)
        }}
        className="min-w-0 max-w-72 truncate rounded px-1.5 py-0.5 text-sm font-medium hover:bg-accent"
      >
        {name}
      </button>
    </Hint>
  )
}
