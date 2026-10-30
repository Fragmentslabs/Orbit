/**
 * The mermaid bundle, served from the app itself.
 *
 * The diagram is drawn inside a WebView, which cannot see the JS bundle of
 * React Native — some copy of the lib has to get there. Fetching from a CDN would leave
 * the drawing dependent on the internet, and this app should not require the internet: it
 * talks to the desktop on the LAN. That is why the bundle is vendored in
 * `assets/mermaid/mermaid.min.txt` (mermaid@11.17.2).
 *
 * The `.txt` extension is not a whim: `js` is a code extension for Metro, and
 * a 3.4 MB `.js` would be transpiled and embedded in the main bundle, paid at the
 * start of everyone. Registered as an asset (`metro.config.js`), it is only
 * copied into the package and read when a diagram shows up.
 *
 * To update the version:
 *   cp node_modules/mermaid/dist/mermaid.min.js \
 *      apps/mobile/assets/mermaid/mermaid.min.txt
 */
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'

import mermaidAsset from '../../assets/mermaid/mermaid.min.txt'

let pending: Promise<string | null> | null = null

/**
 * The lib code, or `null` when the asset could not be read — and then the caller
 * falls back to the source code of the diagram. Read once per session: it is 3.4 MB, and the
 * same text serves every diagram.
 */
export function loadMermaidSource(): Promise<string | null> {
  pending ??= readAsset()
  return pending
}

async function readAsset(): Promise<string | null> {
  try {
    const asset = Asset.fromModule(mermaidAsset)
    // In dev the asset is served by Metro; `downloadAsync` copies it to the cache and
    // fills in `localUri`. In a production build it is already in the package.
    if (!asset.localUri) await asset.downloadAsync()
    if (!asset.localUri) return null
    return await FileSystem.readAsStringAsync(asset.localUri)
  } catch {
    return null
  }
}
