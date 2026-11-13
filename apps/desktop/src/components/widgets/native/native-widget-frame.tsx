import type { ComponentType } from "react"
import type { FragmentWidgetSize } from "@shared/fragments"
import { cn } from "@/lib/utils"
import { ActivityWidget } from "./activity-widget"
import { PipelineWidget } from "./pipeline-widget"
import { RoutinesWidget } from "./routines-widget"
import { UsageChatWidget, UsageDayWidget, UsageProjectWidget } from "./usage-widgets"
import type { NativeWidgetProps } from "./widget-bits"

/** Widget id → the React component that draws it. */
const RENDERERS: Record<string, ComponentType<NativeWidgetProps>> = {
  "usage-day": UsageDayWidget,
  "usage-project": UsageProjectWidget,
  "usage-chat": UsageChatWidget,
  activity: ActivityWidget,
  routines: RoutinesWidget,
  pipeline: PipelineWidget,
}

/**
 * Draws one native widget at the cell size the board gave it. It is deliberately just a
 * component: no iframe, no page, no IPC courier — the same stores the screens read.
 */
export function NativeWidgetFrame({
  widgetId,
  size,
  preview = false,
  className,
}: {
  widgetId: string
  size: FragmentWidgetSize
  /** In the picker: do not start loading anything just because the library is open. */
  preview?: boolean
  className?: string
}) {
  const Renderer = RENDERERS[widgetId]
  if (!Renderer) {
    return <div className={cn("size-full bg-card", className)} />
  }
  return (
    <div className={cn("size-full overflow-hidden bg-card", className)}>
      <Renderer compact={size === "2x1" || size === "1x1"} preview={preview} />
    </div>
  )
}
