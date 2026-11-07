import type { TFunction } from "i18next"
import type { ToolPart } from "@shared/chat"

/** A readable line for what the fragment agent is doing — one place, shared by the feed and the creating screen. */
export function describeFragmentAction(t: TFunction, part: ToolPart): string {
  const path = typeof part.input?.path === "string" ? part.input.path : ""
  const name = typeof part.input?.name === "string" ? part.input.name : ""
  switch (part.tool) {
    case "fragment_create":
      return name ? t("fragments.action.createNamed", { name }) : t("fragments.action.create")
    case "fragment_edit_file":
      return t("fragments.action.edit", { path })
    case "fragment_write_file":
      return t("fragments.action.write", { path })
    case "fragment_read_file":
      return path ? t("fragments.action.readFile", { path }) : t("fragments.action.read")
    case "fragment_delete_file":
      return t("fragments.action.remove", { path })
    case "fragment_logs":
      return t("fragments.action.logs")
    case "fragment_set_ai":
      return t("fragments.action.ai")
    case "fragment_set_models":
      return t("fragments.action.models")
    default:
      return part.title || part.tool
  }
}
