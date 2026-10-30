/* eslint-disable react-hooks/refs -- the flagged accesses are inside
 * Reanimated worklets ('worklet'), which run on the UI thread, outside the
 * React render cycle. Same case as ImageLightbox: the rule is
 * conservative with callbacks handed to gesture libraries. */
/**
 * Memory graph — port of the desktop memory-graph. The layout comes from
 * @orbit/shared (createMemoryGraphJob), so both platforms draw
 * exactly the same positions: the project root in the center and the branches
 * growing in every direction, with a minimum gap guaranteed between the labels.
 * It is a single, continuous view — projects occupy distinct regions of the canvas,
 * with no frame separating one from another; what isolates a project is the filter.
 *
 * The frame goes through neither React nor the JS thread:
 *
 * 1. The whole scene is recorded into a SkPicture (see graph-picture) when the
 *    CONTENT changes — new layout, zoom level, search. Drawing became
 *    replaying a list of commands on the GPU.
 * 2. Pan and pinch write to shared values, and the transform of the <Group> reads from them
 *    straight on the UI thread.
 *
 * Before this the scene was SVG: every circle, stroke and label was a native view,
 * and changing the transform forced the engine to redraw everything on the CPU. A few
 * hundred nodes already choked the drag.
 */
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { View, Text, Pressable, ScrollView, StyleSheet, Platform } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import {
  cancelAnimation,
  runOnJS,
  useAnimatedReaction,
  useDerivedValue,
  useSharedValue,
  withDecay,
  withTiming,
} from 'react-native-reanimated'
import { Canvas, Circle, Group, Picture, matchFont } from '@shopify/react-native-skia'
import { Crosshair, X } from 'lucide-react-native'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@orbit/shared'
import { KIND_COLOR, kindLabel } from './meta'
import { useGraphLayout } from './use-graph-layout'
import { buildGraphIndex, matchingIds } from './graph-index'
import type { GraphIndex, NodeShape, Region } from './graph-index'
import { toSkiaColor, recordScene } from './graph-picture'
import type { Fonts } from './graph-picture'
import { MemoryCard } from './MemoryCard'
import { getThemeTokens } from '~/lib/theme-tokens'
import { useThemeStore } from '~/stores/theme-store'

/** Zoom floor — low enough for a large graph to fit entirely. */
const ZOOM_MIN = 0.04
const ZOOM_MAX = 3

// Levels of detail. Each range drops what, at that zoom, is dirty pixels: the
// label (the most expensive to draw), then the recency ring, then the edges
// that are not from the tree. At the bottom the graph becomes one dot per block.
const ZOOM_LABELS = 0.32
const ZOOM_RINGS = 0.18
const ZOOM_NODES = 0.08

/** Touch slack around the node circle, in screen pixels. */
const TOUCH_SLOP = 14
/** How much the double tap zooms in at once. */
const DOUBLE_TAP_FACTOR = 2.5
/** Wait of the single tap for the double. The RNGH default is 500 ms — half a
 *  second until the card opened was too long for a tap on a node. */
const DOUBLE_TAP_DELAY = 180
const DOUBLE_TAP_MS = 200

interface Transform {
  x: number
  y: number
  k: number
}

/**
 * Range in which the translation of an axis may stop after the inertia. Without it a
 * throw tossed the graph off the screen and there was no way to bring it back
 * except through "Center".
 */
function axisRange(
  minWorld: number,
  maxWorld: number,
  scale: number,
  viewSize: number,
): [number, number] {
  'worklet'
  const margin = Math.min(viewSize * 0.4, 160)
  const lo = margin - maxWorld * scale
  const hi = viewSize - margin - minWorld * scale
  if (lo <= hi) return [lo, hi]
  // Content smaller than the screen: there is no range, so it locks in the middle.
  const middle = (lo + hi) / 2
  return [middle, middle]
}

const FAMILY = Platform.select({ ios: 'Helvetica', default: 'sans-serif' })

export function MemoryGraph({ pool, allById, query, selectedId, onSelect }: {
  /** Visible memories (mode/project filter — the search only highlights) */
  pool: Memory[]
  allById: Map<string, Memory>
  query: string
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const { t } = useTranslation()
  const [size, setSize] = useState({ w: 0, h: 0 })
  /** The scene only appears after the first framing: before it the zoom
   *  is still 1 and the graph would be drawn gigantic for one frame. */
  const [ready, setReady] = useState(false)
  /**
   * Level of detail. Re-recording the scene is the only heavy work left,
   * so it only changes when the zoom crosses a range — and not on the thousands of
   * intermediate values the pinch goes through.
   */
  const [level, setLevel] = useState(3)
  const tokens = getThemeTokens(useThemeStore((s) => s.resolved))

  // ─── Transform: lives on the UI thread ─────────────────────────────────
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const k = useSharedValue(1)
  const widthSV = useSharedValue(0)
  const heightSV = useSharedValue(0)
  /** Box of the whole content — limits the inertia of the drag. */
  const boundsSV = useSharedValue<Region | null>(null)
  /** Zoom of the last framing — reference of the double tap. */
  const fitScaleSV = useSharedValue(1)

  // The transform of the whole canvas, read by Skia on the UI thread itself.
  const transformSV = useDerivedValue(() => [
    { translateX: tx.get() },
    { translateY: ty.get() },
    { scale: k.get() },
  ])

  // The layout is heavy and comes in slices (see useGraphLayout); `now` arrives with
  // it on purpose: loose in the body it would be a new value on every frame.
  const { layout, now, progress, building } = useGraphLayout(pool)

  const textColor = useMemo(() => toSkiaColor(tokens.foreground), [tokens.foreground])
  const primaryColor = useMemo(() => toSkiaColor(tokens.primary), [tokens.primary])

  // Everything the scene needs per node, computed once per layout.
  const index = useMemo(
    () => buildGraphIndex(layout, now, primaryColor),
    [layout, now, primaryColor],
  )

  // The search walks the whole text of each memory. Delayed, it stops
  // happening on every keystroke — and the result is a Set queried by id
  // at recording time, instead of one normalization per node per render.
  const deferredQuery = useDeferredValue(query)
  const matches = useMemo(() => matchingIds(pool, deferredQuery), [pool, deferredQuery])

  const fonts: Fonts = useMemo(
    () => ({
      body: matchFont({ fontFamily: FAMILY, fontSize: 10 }),
      area: matchFont({ fontFamily: FAMILY, fontSize: 11, fontWeight: '600' }),
      root: matchFont({ fontFamily: FAMILY, fontSize: 13, fontWeight: 'bold' }),
    }),
    [],
  )

  /** Turned on at the first gesture: from then on the camera belongs to the user. */
  const interacted = useRef(false)
  const markInteraction = useCallback(() => {
    interacted.current = true
  }, [])

  const apply = useCallback(
    (target: Transform) => {
      cancelAnimation(tx)
      cancelAnimation(ty)
      tx.set(target.x)
      ty.set(target.y)
      k.set(target.k)
    },
    [tx, ty, k],
  )

  /** Reframes the content in the container. */
  const fitView = useCallback(
    (w = size.w, h = size.h) => {
      if (!w || !h || index.total === 0) return
      const bounds = index.bounds
      boundsSV.set(bounds)
      const pad = 80
      const minX = bounds.minX - pad
      const maxX = bounds.maxX + pad
      const minY = bounds.minY - pad
      const maxY = bounds.maxY + pad
      // Large graphs sit well below the pinch floor — without the clamp,
      // "center" led to a zoom the gesture could not come back from.
      const scale = Math.max(ZOOM_MIN, Math.min(w / (maxX - minX), h / (maxY - minY), 1.4))
      fitScaleSV.set(scale)
      apply({
        k: scale,
        x: w / 2 - ((minX + maxX) / 2) * scale,
        y: h / 2 - ((minY + maxY) / 2) * scale,
      })
      setReady(true)
      setLevel(scale >= ZOOM_LABELS ? 3 : scale >= ZOOM_RINGS ? 2 : scale >= ZOOM_NODES ? 1 : 0)
    },
    [index, size, apply, boundsSV, fitScaleSV],
  )

  // ─── Gestures ──────────────────────────────────────────────────────────
  // All in worklets: none of these callbacks wakes the JS thread.
  //
  // Pan and pinch have separate bases and do not overlap: the pan only accepts one
  // finger, and the pinch handles the zoom AND the two-finger drag (the focus moving already
  // moves the content). When the two shared one base, each `onStart`
  // overwrote the other's and the zoom went, came back and went again.
  const panBaseX = useSharedValue(0)
  const panBaseY = useSharedValue(0)
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .maxPointers(1)
        .onStart(() => {
          'worklet'
          cancelAnimation(tx)
          cancelAnimation(ty)
          panBaseX.set(tx.get())
          panBaseY.set(ty.get())
          runOnJS(markInteraction)()
        })
        .onUpdate((e) => {
          'worklet'
          // Dragging is a one-finger thing. `maxPointers(1)` already rejects the
          // gesture when a second finger touches, but the check here is free
          // and does not depend on that RNGH detail.
          if (e.numberOfPointers !== 1) return
          tx.set(panBaseX.get() + e.translationX)
          ty.set(panBaseY.get() + e.translationY)
        })
        .onEnd((e) => {
          'worklet'
          // Inertia: the content keeps gliding and brakes on its own, held to the
          // range in which there is still graph left on screen.
          const bounds = boundsSV.get()
          if (!bounds) return
          const [loX, hiX] = axisRange(bounds.minX, bounds.maxX, k.get(), widthSV.get())
          const [loY, hiY] = axisRange(bounds.minY, bounds.maxY, k.get(), heightSV.get())
          tx.set(withDecay({ velocity: e.velocityX, clamp: [loX, hiX], rubberBandEffect: true }))
          ty.set(withDecay({ velocity: e.velocityY, clamp: [loY, hiY], rubberBandEffect: true }))
        }),
    [tx, ty, k, panBaseX, panBaseY, boundsSV, widthSV, heightSV, markInteraction],
  )

  /** Point of the CONTENT that was under the fingers when the pinch started. */
  const pinchBaseK = useSharedValue(1)
  const pinchFocoX = useSharedValue(0)
  const pinchFocoY = useSharedValue(0)
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart((e) => {
          'worklet'
          cancelAnimation(tx)
          cancelAnimation(ty)
          runOnJS(markInteraction)()
          pinchBaseK.set(k.get())
          pinchFocoX.set((e.focalX - tx.get()) / k.get())
          pinchFocoY.set((e.focalY - ty.get()) / k.get())
        })
        .onUpdate((e) => {
          'worklet'
          // On releasing the pinch one finger leaves before the other, and the focus — which is the
          // midpoint between them — collapses onto what is left. That update
          // is a jump, not a gesture: applying it pulled the canvas toward the
          // remaining finger instead of stopping at the zoom where the pinch ended.
          if (e.numberOfPointers < 2) return
          const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinchBaseK.get() * e.scale))
          // The anchor point is fixed from the start of the gesture. Recomputing it
          // every frame from the CURRENT focus against the OLD base made the
          // anchor slide along with the fingers.
          k.set(scale)
          tx.set(e.focalX - pinchFocoX.get() * scale)
          ty.set(e.focalY - pinchFocoY.get() * scale)
        }),
    [tx, ty, k, pinchBaseK, pinchFocoX, pinchFocoY, markInteraction],
  )

  // Tap: a single handler, with hit testing by distance. With the scene recorded into a
  // picture there is no longer a view per node to receive the finger — and it made no sense to
  // have one: it was thousands of touch targets just to find one circle.
  const indexRef = useRef<GraphIndex>(index)
  useEffect(() => {
    indexRef.current = index
  }, [index])
  /** In the summarized mode there is no node drawn to hit. */
  const collapsedRef = useRef(false)
  const handleTap = useCallback(
    (wx: number, wy: number, scale: number) => {
      if (collapsedRef.current) return
      const slop = TOUCH_SLOP / scale
      let best: NodeShape | null = null
      let bestDist = Infinity
      for (const node of indexRef.current.nodes) {
        const dx = node.x - wx
        const dy = node.y - wy
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist <= node.r + slop && dist < bestDist) {
          bestDist = dist
          best = node
        }
      }
      if (!best) return
      const id = best.id
      onSelect(id === selectedId ? null : id)
    },
    [onSelect, selectedId],
  )
  const tapGesture = useMemo(
    () =>
      Gesture.Tap()
        .maxDistance(12)
        .onEnd((e, success) => {
          'worklet'
          // onEnd also arrives when the touch became a drag and the gesture failed.
          if (!success) return
          runOnJS(handleTap)((e.x - tx.get()) / k.get(), (e.y - ty.get()) / k.get(), k.get())
        }),
    [handleTap, tx, ty, k],
  )

  // Double tap: zooms in anchored on the tapped point and, once zoomed in, goes back to
  // the whole view. With the zoom floor at 4% of the scale, getting close only with the
  // pinch took several gestures in a row.
  const doubleTap = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDistance(24)
        .maxDelay(DOUBLE_TAP_DELAY)
        .onEnd((e, success) => {
          'worklet'
          if (!success) return
          runOnJS(markInteraction)()
          const current = k.get()
          const back = current > fitScaleSV.get() * 1.5
          const target = back ? fitScaleSV.get() : Math.min(ZOOM_MAX, current * DOUBLE_TAP_FACTOR)
          // Point of the content under the finger: it is what stays still while the
          // zoom moves.
          const mx = (e.x - tx.get()) / current
          const my = (e.y - ty.get()) / current
          k.set(withTiming(target, { duration: DOUBLE_TAP_MS }))
          tx.set(withTiming(e.x - mx * target, { duration: DOUBLE_TAP_MS }))
          ty.set(withTiming(e.y - my * target, { duration: DOUBLE_TAP_MS }))
        }),
    [tx, ty, k, fitScaleSV, markInteraction],
  )

  // Exclusive: the single tap only counts after the double failed, otherwise the
  // first tap of a double would already open the card.
  const composed = useMemo(
    () => Gesture.Simultaneous(panGesture, pinchGesture, Gesture.Exclusive(doubleTap, tapGesture)),
    [panGesture, pinchGesture, doubleTap, tapGesture],
  )

  /**
   * Framing: once when the graph appears and once when the layout
   * becomes ready — not on every preview.
   *
   * The sliced layout publishes one preview at a time; reframing on each one
   * made the camera jump along with the nodes settling, which was half of the
   * feeling of "it keeps reorganizing".
   */
  const framed = useRef<'never' | 'preview' | 'final'>('never')
  useEffect(() => {
    if (!size.w || !size.h || index.total === 0) return
    const target = building ? 'preview' : 'final'
    if (framed.current === target || framed.current === 'final') return
    // Whoever already dragged or zoomed has taken over the camera: the final framing does
    // not override that.
    if (target === 'final' && interacted.current && framed.current !== 'never') {
      framed.current = 'final'
      return
    }
    framed.current = target
    fitView(size.w, size.h)
  }, [index, size, building, fitView])

  // ─── Level of detail ───────────────────────────────────────────────────
  useAnimatedReaction(
    () => {
      const scale = k.get()
      return scale >= ZOOM_LABELS ? 3 : scale >= ZOOM_RINGS ? 2 : scale >= ZOOM_NODES ? 1 : 0
    },
    (currentLevel, previousLevel) => {
      'worklet'
      if (currentLevel !== previousLevel) runOnJS(setLevel)(currentLevel)
    },
  )

  useEffect(() => {
    collapsedRef.current = level === 0
  }, [level])

  // The recorded scene. This is where the cost lives — and it is only paid when the layout,
  // the level of detail, the search or the theme change.
  const picture = useMemo(
    () => recordScene(index, { level, matches, fonts, textColor }),
    [index, level, matches, fonts, textColor],
  )

  const selectedShape = useMemo(
    () => (selectedId ? index.nodes.find((n) => n.id === selectedId) : undefined),
    [index, selectedId],
  )

  const selected = selectedId ? allById.get(selectedId) : undefined
  // Stored as an element: with a node selected, the card would be remounted on
  // every render (the `related` array alone was already a new prop per render).
  const selectedCard = useMemo(
    () =>
      selected ? (
        <View style={s.selectedOverlay}>
          <Pressable
            onPress={() => onSelect(null)}
            style={[s.selectedClose, { backgroundColor: tokens.muted }]}
          >
            <X size={16} color={tokens.mutedForeground} />
          </Pressable>
          <ScrollView style={{ maxHeight: 260 }}>
            <MemoryCard
              memory={selected}
              related={selected.relatedIds
                .map((id) => allById.get(id))
                .filter((m): m is Memory => m != null)}
              onSelectRelated={onSelect}
            />
          </ScrollView>
        </View>
      ) : null,
    [selected, allById, onSelect, tokens],
  )

  const pct = Math.round(progress * 100)

  return (
    <View style={{ flex: 1, gap: 8 }}>
      {/* Toolbar: center + legend */}
      <View style={s.toolbar}>
        <Pressable onPress={() => fitView()} style={[s.centerBtn, { borderColor: tokens.border }]}>
          <Crosshair size={13} color={tokens.foreground} />
          <Text style={[s.centerBtnText, { color: tokens.foreground }]}>
            {t('memoryGraph.center')}
          </Text>
        </Pressable>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.legend}>
          {(Object.keys(KIND_COLOR) as (keyof typeof KIND_COLOR)[]).map((kind) => (
            <View key={kind} style={s.legendItem}>
              <View style={[s.legendDot, { backgroundColor: KIND_COLOR[kind] }]} />
              <Text style={[s.legendText, { color: tokens.mutedForeground }]}>{kindLabel(kind)}</Text>
            </View>
          ))}
        </ScrollView>
      </View>

      {/* Canvas */}
      <View
        style={[s.canvas, { borderColor: tokens.border, backgroundColor: tokens.card + '80' }]}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout
          widthSV.set(width)
          heightSV.set(height)
          setSize((current) => (current.w === width && current.h === height ? current : { w: width, h: height }))
        }}
      >
        <GestureDetector gesture={composed}>
          <Canvas style={s.skia}>
            <Group transform={transformSV}>
              {ready && picture && <Picture picture={picture} />}
              {/* Highlight of the selected node outside the picture: it is what changes on a finger
                  tap, and re-recording the whole scene because of it would be absurd. */}
              {ready && selectedShape && (
                <>
                  <Circle
                    cx={selectedShape.x}
                    cy={selectedShape.y}
                    r={selectedShape.r + 4}
                    color={selectedShape.color}
                    style="stroke"
                    strokeWidth={2.5}
                    opacity={0.9}
                  />
                  <Circle
                    cx={selectedShape.x}
                    cy={selectedShape.y}
                    r={selectedShape.r}
                    color={selectedShape.color}
                    style="stroke"
                    strokeWidth={2.5}
                  />
                </>
              )}
            </Group>
          </Canvas>
        </GestureDetector>

        {/* Layout being built. With a preview on screen it becomes a discreet strip in the
            corner; without a preview (graph too large) it takes the center. */}
        {building && !layout && (
          <View style={s.building}>
            <Text style={[s.buildingText, { color: tokens.mutedForeground }]}>
              {t('memoryGraph.building')}
            </Text>
            <View style={[s.track, { backgroundColor: tokens.muted }]}>
              <View style={[s.trackFill, { backgroundColor: tokens.primary, width: `${pct}%` }]} />
            </View>
            <Text style={[s.buildingPct, { color: tokens.mutedForeground }]}>{pct}%</Text>
          </View>
        )}
        {building && layout && (
          <View style={[s.chip, { backgroundColor: tokens.muted }]}>
            <Text style={[s.chipText, { color: tokens.mutedForeground }]}>
              {t('memoryGraph.building')} {pct}%
            </Text>
          </View>
        )}

        {/* Card of the selected memory — bottom overlay */}
        {selectedCard}
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  centerBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  centerBtnText: { fontSize: 12, fontWeight: '500' },
  legend: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontSize: 11 },

  canvas: { flex: 1, borderRadius: 14, borderWidth: 1, overflow: 'hidden' },
  skia: { flex: 1 },

  building: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  buildingText: { fontSize: 12 },
  buildingPct: { fontSize: 11, fontVariant: ['tabular-nums'] },
  track: { width: 160, height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: 4, borderRadius: 2 },

  chip: {
    position: 'absolute',
    top: 8,
    left: 8,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  chipText: { fontSize: 11, fontVariant: ['tabular-nums'] },

  selectedOverlay: { position: 'absolute', left: 8, right: 8, bottom: 8 },
  selectedClose: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
