import { useTranslation } from "react-i18next"
import { SegmentedControl } from "@/components/ui/segmented-control"
import type { ViewScope } from "@/src/stores/memories-scope-store"

/**
 * Header toggle of the pages that can show the chat's data, the code's or both (Memories,
 * Usage). It filters what the page lists; it does not switch the workspace mode.
 */
export function ViewScopeToggle({ value, onChange }: { value: ViewScope; onChange: (scope: ViewScope) => void }) {
  const { t } = useTranslation()
  return (
    <SegmentedControl<ViewScope>
      size="sm"
      value={value}
      onChange={onChange}
      options={[
        { value: "chat", label: t("viewScope.chat") },
        { value: "code", label: t("viewScope.code") },
        { value: "all", label: t("viewScope.all") },
      ]}
    />
  )
}
