import type { NativeImage, WebContents } from 'electron'

/**
 * `capturePage` on an offscreen window SOMETIMES FAILS with `UnknownVizError`:
 * the same frame, in the same window, captures, fails and captures again in three
 * calls in a row (measured on Electron 44, Windows). Untreated, a look from
 * motion_frame broke at random — and a render of 500 frames broke almost
 * for sure, halfway through.
 *
 * Here the capture asks for a fresh frame (`invalidate`) and retries, with a
 * short, growing wait. A failure that persists across attempts is real and is raised.
 */
export async function capturePageReliably(contents: WebContents, attempts = 5): Promise<NativeImage> {
  let last: unknown = null
  for (let i = 0; i < attempts; i++) {
    try {
      const image = await contents.capturePage()
      if (!image.isEmpty()) return image
      last = new Error('the capture came back empty')
    } catch (err) {
      last = err
    }
    if (contents.isDestroyed()) break
    contents.invalidate()
    await new Promise((resolve) => setTimeout(resolve, 30 * (i + 1)))
  }
  throw last instanceof Error ? last : new Error(String(last))
}
