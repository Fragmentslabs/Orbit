import path from 'node:path'
import { listMedia } from '../media'
import { panelMotionPreview } from '../panel-browser'
import { motionAudioPlan, type MotionAudioPlan } from './motion-audio'
import { registerMotionCover } from './motion-gallery'
import { describeLayers, measureMotionLayers } from './motion-layers'
import { describeLint } from './motion-lint'
import { lintMotionComposition } from './motion-lint-run'
import { describeMasterFx, describeTrackFx } from './motion-audio-fx'
import { prepareMotionPreview } from './motion-preview'
import { describeTransitions } from './motion-transitions'
import { motionVideoAudioTracks } from './motion-video-audio'
import { getMotion, registerMotion } from './motion-store'

/** Does the piece already have an item in the gallery? The `motionId` is the link, not the folder. */
async function isInGallery(id: string): Promise<boolean> {
  try {
    const items = await listMedia({ kind: 'motion' })
    return items.some((item) => item.motionId === id)
  } catch {
    // Unreadable index: treat it as "not there", and the record below rewrites it.
    return false
  }
}

/**
 * Reopens a piece that is ALREADY in the registry — the chat card, the Media tile.
 *
 * It measures and reports nothing: whoever clicked wants to see the piece, not a report.
 * `false` when the composition left the registry (a piece of a deleted project
 * goes with it), and then the caller says it is no longer there.
 */
export async function reopenMotion(id: string): Promise<boolean> {
  const entry = await getMotion(id)
  if (!entry) return false
  // After restarting the app the registry comes back from disk, but the watcher does not: without
  // registering again, the reopened piece would open without live reload. It is idempotent
  // (same id, same entry) and only reconnects the watcher.
  await registerMotion(entry.folder, entry.entry).catch(() => {})
  // No `sessionId` on purpose: the renderer resolves the bucket by the ACTIVE chat. The
  // session recorded in the registry is the one of ORIGIN — for an old piece it is another
  // conversation, and the tab would be born in a panel that is not on screen (the click
  // seemed to do nothing).
  panelMotionPreview({
    id,
    entry: path.relative(entry.folder, entry.entry),
    title: path.basename(entry.folder),
    path: entry.entry,
  })
  return true
}

/**
 * Opens a composition in the Motion tab and tells the agent how it turned out.
 *
 * It is the common step of motion_write, motion_edit and motion_preview (the composition
 * in Orbit's storage, in both modes): registers the folder, tells the panel
 * to open (or focus) the
 * tab and MEASURES the composition in the same offscreen window the tab uses — the agent
 * learns right now whether it loads and who enters and leaves, and when, instead of
 * finding out from the user complaining about a spinning screen.
 */
export async function openMotionAndReport(input: {
  /** The .html entry (or its folder), already resolved and authorized. */
  target: string
  /** Working folder that registers the composition. */
  root?: string
  sessionId: string
  /** How the agent calls the composition in the text (relative path or name). */
  label: string
  /** What to do next, said in the language of the tools the agent has. */
  nextStep: string
  /** What to do when it did not load. */
  fixHint: string
  /** false in a worker: the piece is registered and measured, but no tab opens. */
  openTab?: boolean
}): Promise<string> {
  const preview = await prepareMotionPreview(input.target, { root: input.root, sessionId: input.sessionId })
  const name = path.basename(preview.folder)
  // The id makes the same composition come back to the SAME tab; `entry` is the path inside
  // the folder and `path` the absolute one, which the chat note gives back to the agent.
  if (input.openTab !== false) {
    panelMotionPreview({ id: preview.id, entry: preview.entry, title: name, path: preview.file, sessionId: input.sessionId })
  }
  try {
    const measured = await measureMotionLayers(preview.id, preview.url)
    // The piece enters the gallery the FIRST time it opens: that is what makes it
    // reopenable when the panel's tab is closed. Once only (the cover costs one
    // extra offscreen window) and best-effort — the preview never depends on it.
    if (!(await isInGallery(preview.id))) {
      await registerMotionCover(preview.id, { sessionId: input.sessionId }).catch(() => false)
    }
    // The tracks enter the report: the agent needs to know that the piece ALREADY has sound
    // (the tab plays it with the preview and the render mixes it) and at which instants, before
    // changing its length or rewriting the composition.
    let audio = ''
    let plan: MotionAudioPlan | null = null
    try {
      plan = await motionAudioPlan(preview.folder, undefined, await motionVideoAudioTracks(preview.folder, measured.videos))
      const { tracks, master } = plan
      if (tracks.length) {
        audio = `Audio (${tracks.length} track${tracks.length > 1 ? 's' : ''}, mixed by the render — from audio.json and from the <video> elements that are not muted): ${tracks
          .map((track) => {
            const span = track.end === undefined ? `${track.start}s→end` : `${track.start}s→${track.end}s`
            const level = track.gainDb === 0 ? '' : `, ${track.gainDb}dB`
            const from = track.offset ? `, file from ${track.offset}s` : ''
            const looped = track.loop ? ', looped' : ''
            const bed = track.duck ? ', ducked under the others' : ''
            const treated = describeTrackFx(track.fx)
            const where = track.path ? '' : ', OUTSIDE the composition folder (the tab cannot play it)'
            return `"${track.name}" (${span}${from}${looped}${level}${bed}${treated ? `, ${treated}` : ''}${where})`
          })
          .join('; ')}.`
        const finish = describeMasterFx(master)
        if (finish) audio += ` Master: ${finish}.`
      }
    } catch (err) {
      audio = `Audio: the manifest in the composition folder is broken — ${err instanceof Error ? err.message : String(err)}. The render will fail on it.`
    }
    // The lint joins what is only seen in the composition's text (wall clock,
    // missing file…) with what is only seen while running (transition outside the piece,
    // audio track after the end).
    const lint = await lintMotionComposition({
      entry: preview.file,
      folder: preview.folder,
      runtime: { fps: measured.fps, durationInFrames: measured.durationInFrames, transitions: measured.transitions },
      audio: plan,
    })
    return [
      `Motion "${name}" is open in the Motion tab of the right panel (${input.label}) and loads fine: ${measured.width}x${measured.height}, ${measured.durationInFrames} frames at ${measured.fps} fps (${(measured.durationInFrames / measured.fps).toFixed(2)} s).`,
      measured.failedFonts.length ? `Fonts that failed to load: ${measured.failedFonts.join(', ')}.` : '',
      measured.scriptErrors.length
        ? `[error] The composition's scripts threw: ${measured.scriptErrors.join(' | ')}. Fix this before anything else — the piece is probably not moving.`
        : '',
      audio,
      describeTransitions(measured.transitions),
      'Layers (when each enters and leaves the frame):',
      describeLayers(measured.layers, measured.fps),
      describeLint(lint),
      input.nextStep,
    ]
      .filter(Boolean)
      .join('\n')
  } catch (err) {
    // The composition did not load: the static lint (without running anything) usually points to
    // the reason — a missing file, a script that does not exist.
    const lint = await lintMotionComposition({ entry: preview.file, folder: preview.folder })
    return [
      `Motion "${name}" is open in the Motion tab, but it DID NOT LOAD: ${err instanceof Error ? err.message : String(err)}. ` +
        `The user is looking at an empty stage — ${input.fixHint}`,
      lint.length ? describeLint(lint) : '',
    ]
      .filter(Boolean)
      .join('\n')
  }
}
