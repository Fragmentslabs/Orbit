import {
  FRAGMENT_WIDGET_GAP,
  FRAGMENT_WIDGET_UNIT,
  type FragmentManifest,
  type FragmentWidgetSize,
} from "@shared/fragments"
import { cn } from "@/lib/utils"
import { FragmentFrame } from "@/src/components/fragment-tab"
import { NativeWidgetFrame } from "@/src/components/widgets/native/native-widget-frame"
import { isNativeFragment } from "@/src/lib/native-widgets"
import { sizeToBox } from "@/src/lib/widget-board"

const UNIT = FRAGMENT_WIDGET_UNIT
const GAP = FRAGMENT_WIDGET_GAP

/**
 * A widget drawn small: the fragment's own page loaded with `?widget=<id>&size=<size>`, at the
 * size it declared and scaled down to the cell the caller has room for. It is the same frame the
 * board uses, read-only — a preview shows what the widget saved, but can never spend or write.
 */
export function WidgetPreview({
  fragment,
  widget,
  size,
  unit = 46,
  className,
}: {
  fragment: FragmentManifest
  widget: string
  size: FragmentWidgetSize
  /** One cell of the preview, in pixels (the real one is 72). */
  unit?: number
  className?: string
}) {
  const { cols, rows } = sizeToBox(size)
  const scale = unit / UNIT
  const width = cols * UNIT + (cols - 1) * GAP
  const height = rows * UNIT + (rows - 1) * GAP

  return (
    <span
      className={cn("relative block shrink-0 overflow-hidden bg-card", className)}
      style={{ width: Math.round(width * scale), height: Math.round(height * scale) }}
    >
      <span
        className="pointer-events-none absolute left-0 top-0 origin-top-left"
        style={{ width, height, transform: `scale(${scale})` }}
      >
        {isNativeFragment(fragment.id) ? (
          <NativeWidgetFrame widgetId={widget} size={size} preview className="size-full" />
        ) : (
          <FragmentFrame
            manifest={fragment}
            reloads={0}
            readOnly
            widget={widget}
            size={size}
            className="size-full border-0 bg-card"
          />
        )}
      </span>
    </span>
  )
}
