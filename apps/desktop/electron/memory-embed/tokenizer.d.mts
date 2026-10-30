/** Types of the compact tokenizer (tokenizer.mjs). */
export interface LoadedTokenizer {
  bytes: number
  encode(text: string, maxTokens: number): number[]
  decode(ids: number[]): string
}

export declare function compileTokenizer(jsonPath: string, outPath: string): {
  bytes: number
  merges: number
  vocab: number
}
export declare function loadTokenizer(binPath: string): LoadedTokenizer
