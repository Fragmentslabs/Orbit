/** Types of the embedding engine (engine.mjs) for the TypeScript side. */
export interface EmbedderOptions {
  modelPath: string
  tokenizerPath: string
  dim?: number
  maxTokens?: number
  ortModule?: string
  threads?: number
}

export interface Embedder {
  dim: number
  tokenizerBytes: number
  embed(texts: string[]): Promise<Float32Array[]>
  dispose(): Promise<void>
}

export declare function createEmbedder(opts: EmbedderOptions): Promise<Embedder>
export declare function modelFiles(root: string, id: string): {
  modelPath: string
  tokenizerJson: string
  tokenizerPath: string
}
export declare const MODELS: Record<string, { repo: string; bytes: number }>
