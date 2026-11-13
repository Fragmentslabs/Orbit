import type { TFunction } from "i18next"
import type { WorkspaceView } from "@/lib/workspace-context"
import type { FragmentManifest, FragmentWidget, FragmentWidgetSize } from "@shared/fragments"

/**
 * The widgets that ship with Orbit.
 *
 * They are drawn by the app itself — React reading the same stores the screens read — and not
 * by a fragment page. To the board they are just another source: a reserved fragment id, a
 * manifest-shaped list of what it offers and the same placements, so cells, pages, drag and
 * sizes keep working without knowing the difference.
 */
export const NATIVE_FRAGMENT_ID = "orbit-native"

export const NATIVE_WIDGET_IDS = [
  "usage-day",
  "usage-project",
  "usage-chat",
  "activity",
  "routines",
  "pipeline",
] as const

export type NativeWidgetId = (typeof NATIVE_WIDGET_IDS)[number]

interface NativeWidgetSpec {
  id: NativeWidgetId
  sizes: FragmentWidgetSize[]
  /** The screen a click on the card opens. */
  destination: WorkspaceView
  /** English fallback used only if the translation is missing. */
  name: string
  description: string
}

const SPECS: readonly NativeWidgetSpec[] = [
  {
    id: "usage-day",
    sizes: ["2x2", "2x1"],
    destination: "analytics",
    name: "Today",
    description: "Time, tokens and chats of today",
  },
  {
    id: "usage-project",
    sizes: ["2x2", "2x1"],
    destination: "analytics",
    name: "Project",
    description: "What the open project spent",
  },
  {
    id: "usage-chat",
    sizes: ["2x2", "2x1"],
    destination: "analytics",
    name: "Chat",
    description: "What this conversation spent",
  },
  {
    id: "activity",
    sizes: ["2x2"],
    destination: "analytics",
    name: "Activity",
    description: "A year of work as a grid of days",
  },
  {
    id: "routines",
    sizes: ["2x2", "2x1"],
    destination: "routines",
    name: "Routines",
    description: "The next run, what is running and what just ran",
  },
  {
    id: "pipeline",
    sizes: ["2x2", "2x1"],
    destination: "pipeline",
    name: "Pipeline",
    description: "How many tasks are running and what finished",
  },
]

/** The translation segment of each widget ("usage-day" → "usageDay"). */
const LABEL_SEGMENT: Record<NativeWidgetId, string> = {
  "usage-day": "usageDay",
  "usage-project": "usageProject",
  "usage-chat": "usageChat",
  activity: "activity",
  routines: "routines",
  pipeline: "pipeline",
}

/**
 * The source of the native widgets, shaped as a fragment so the board can treat it like any
 * other one. It is never listed as a fragment, never opened as a page and has no files: only
 * its `widgets` list and its icon are read.
 */
export const NATIVE_FRAGMENT: FragmentManifest = {
  id: NATIVE_FRAGMENT_ID,
  name: "Orbit",
  icon: "orbit",
  kind: "screen",
  pinned: { sidebar: false, panel: false },
  sdk: 1,
  requests: [],
  grants: [],
  hosts: [],
  mcp: [],
  widgets: SPECS.map((spec) => ({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    sizes: spec.sizes,
    destination: spec.destination,
  })),
  revision: 0,
  createdAt: 0,
  updatedAt: 0,
}

export function isNativeFragment(fragmentId: string): boolean {
  return fragmentId === NATIVE_FRAGMENT_ID
}

export function isNativeWidgetId(widgetId: string): widgetId is NativeWidgetId {
  return (NATIVE_WIDGET_IDS as readonly string[]).includes(widgetId)
}

/** The translated name of a native widget; fragments keep the name they declared. */
export function nativeWidgetName(widget: Pick<FragmentWidget, "id" | "name">, t: TFunction): string {
  if (!isNativeWidgetId(widget.id)) return widget.name
  return t(`widgets.nativeWidgets.${LABEL_SEGMENT[widget.id]}.name`, { defaultValue: widget.name })
}

/** The translated one-line description of a native widget. */
export function nativeWidgetDescription(widget: Pick<FragmentWidget, "id" | "description">, t: TFunction): string {
  if (!isNativeWidgetId(widget.id)) return widget.description ?? ""
  const fallback = widget.description ?? ""
  return t(`widgets.nativeWidgets.${LABEL_SEGMENT[widget.id]}.description`, { defaultValue: fallback })
}

/** Where a click on a native card goes; null for fragment widgets. */
export function nativeWidgetDestination(widgetId: string): WorkspaceView | null {
  return SPECS.find((spec) => spec.id === widgetId)?.destination ?? null
}
