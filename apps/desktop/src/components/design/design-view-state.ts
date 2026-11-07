import type { ArtifactViewValue } from "@shared/artifacts"

/**
 * What the Design tab tells the chat about: the artboards on the canvas, the one the selection is
 * in, and the selected element. Element paths are child indexes from <body>, which is also how the
 * design tools address them.
 */
export function designViewState(view: {
  title: string
  boards: Array<{ file: string; w: number; h: number }>
  selection: { file: string; path: number[] | null } | null
  extraSelected: number
  element: { tag: string; text: string | null } | null
}): Record<string, ArtifactViewValue | null> {
  const { selection, element } = view
  return {
    canvas: view.title,
    artboards: view.boards.map((board) => `${board.file} (${Math.round(board.w)}x${Math.round(board.h)})`),
    "active artboard": selection?.file ?? null,
    "selected element": selection?.path
      ? `<${element?.tag ?? "element"}> at path ${selection.path.join(".") || "root"}${element?.text ? ` with text "${element.text.slice(0, 80)}"` : ""}`
      : selection
        ? "the whole artboard"
        : null,
    "also selected": view.extraSelected > 0 ? `${view.extraSelected} more element${view.extraSelected === 1 ? "" : "s"} in the group` : null,
  }
}
