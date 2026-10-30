import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { CheckIcon, SearchIcon } from "lucide-react"

import type { Task } from "@shared/pipeline"
import { cn } from "@/lib/utils"
import { Truncate } from "@/components/ui/truncated-text"

/**
 * Contents of a task picker: a search field on top and the filtered list below.
 * It lives apart because two places need exactly this — the dependency picker of
 * the creation dialog (multiple choice) and the "add dependency" of the task
 * modal (single choice).
 *
 * The search state lives here: PopoverContent unmounts when it closes, so it
 * resets by itself on the next open.
 */
export function SearchableTaskList({ tasks, selected, onPick }: {
  tasks: Task[]
  /**
   * Ids already marked — draws the checkbox. Absent = single choice, without a
   * checkbox, for when the click already resolves the action.
   */
  selected?: string[]
  onPick: (id: string) => void
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState("")

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return tasks
    return tasks.filter((task) => task.title.toLowerCase().includes(needle))
  }, [tasks, search])

  return (
    <>
      <div className="flex items-center gap-1.5 border-b px-2">
        <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("pipeline.searchTask")}
          className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {filtered.length === 0 ? (
          <p className="px-2 py-3 text-center text-[11px] text-muted-foreground">
            {t("pipeline.noTasks")}
          </p>
        ) : (
          filtered.map((task) => {
            const marked = selected?.includes(task.id) ?? false
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => onPick(task.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
              >
                {selected && (
                  <span
                    className={cn(
                      "flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
                      marked && "border-primary bg-primary text-primary-foreground",
                    )}
                  >
                    {marked && <CheckIcon className="size-2.5" />}
                  </span>
                )}
                
                  <Truncate>
                      <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  </Truncate>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t(`pipeline.status.${task.status}`)}
                </span>
              </button>
            )
          })
        )}
      </div>
    </>
  )
}
