import type { ArtifactViewValue } from "@shared/artifacts"

interface ViewLayer {
  name: string
  /** Inclusive frame ranges where the layer is in the scene. */
  spans: Array<[number, number]>
}

/**
 * What the Motion tab tells the chat about: the layer or sound that is selected, the frame of the
 * playhead, and the timeline (when each layer is in the scene). Plain values; main turns them into text.
 */
export function motionViewState(view: {
  title: string
  selected: string | null
  frame: number
  durationInFrames: number
  fps: number
  layers: ViewLayer[]
}): Record<string, ArtifactViewValue | null> {
  const { frame, fps, durationInFrames } = view
  return {
    piece: view.title,
    selected: view.selected,
    playhead: durationInFrames > 0 ? `frame ${frame} of ${durationInFrames} (${(frame / fps).toFixed(2)}s of ${(durationInFrames / fps).toFixed(2)}s, ${fps} fps)` : null,
    timeline: view.layers.map((layer) => `${layer.name}: frames ${layer.spans.map(([a, b]) => `${a}-${b}`).join(", ") || "none"}`),
  }
}
