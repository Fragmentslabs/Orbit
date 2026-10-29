/**
 * Renderizadores das parts de mídia/peça da resposta do assistente.
 *
 * Cada tipo tem o seu arquivo porque cada um resolve um problema diferente
 * (player de áudio com seek, player de vídeo com poster, HTML em WebView), e o
 * `ChatAssistantMessage` só escolhe qual usar. O host HTML é único (`PieceView`)
 * justamente para a próxima fase — motion, design, slides — não precisar de um
 * segundo.
 */
export { AudioPartView } from './AudioPartView'
export { VideoPartView } from './VideoPartView'
export { ArtifactPartView } from './ArtifactPartView'
export { DocumentPartView } from './DocumentPartView'
export { UnavailablePart } from './UnavailablePart'
