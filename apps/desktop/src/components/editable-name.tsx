import { useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Hint } from "@/components/ui/hint"
import { cn } from "@/lib/utils"

/**
 * The name of whatever is open, in the window header: a click turns it into an input with the
 * text already selected, so typing replaces it. Enter or leaving the field saves; Esc gives up.
 * The routine, the pipeline and the fragment all rename in this same place.
 */
export function EditableName({
  value,
  onSave,
  label,
  className,
}: {
  value: string
  onSave: (next: string) => void
  label: string
  className?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== value) onSave(next)
    else setDraft(value)
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
            setDraft(value)
            setEditing(false)
          }
        }}
        className="h-7 w-56 text-sm"
        aria-label={label}
      />
    )
  }

  return (
    <Hint label={label}>
      <button
        type="button"
        onClick={() => {
          setDraft(value)
          setEditing(true)
        }}
        className={cn(
          "min-w-0 max-w-72 truncate rounded px-1.5 py-0.5 text-[13.5px] font-semibold hover:bg-accent",
          className,
        )}
      >
        {value}
      </button>
    </Hint>
  )
}
