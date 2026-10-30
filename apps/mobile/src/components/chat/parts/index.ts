/**
 * Renderers of the media/piece parts of the assistant answer.
 *
 * Each type has its own file because each one solves a different problem
 * (audio player with seek, video player with poster, HTML in a WebView), and
 * `ChatAssistantMessage` only chooses which one to use. The HTML host is single (`PieceView`)
 * precisely so that the next phase — motion, design, slides — does not need a
 * second one.
 */
export { AudioPartView } from './AudioPartView'
export { VideoPartView } from './VideoPartView'
export { ArtifactPartView } from './ArtifactPartView'
export { DocumentPartView } from './DocumentPartView'
export { UnavailablePart } from './UnavailablePart'
