import { useTranslation } from "react-i18next"
import { PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useStartCreationChat } from "@/src/hooks/use-creation-chat"

/** "Nova rotina" in the top bar of the Routines page: it starts the creation chat. */
export function RoutinesNewButton() {
  const { t } = useTranslation()
  const startCreation = useStartCreationChat()
  return (
    <Button size="sm" className="h-7 gap-1.5 px-2.5 text-[11px]" onClick={() => void startCreation("routine")}>
      <PlusIcon className="size-3.5" />
      {t("routines.list.new")}
    </Button>
  )
}
