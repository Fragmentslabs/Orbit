export interface DetectResult {
  providerId: string
  name: string
  baseURL: string
  detected: boolean
  models: string[]
  error?: string
}

const DETECTORS: {
  providerId: string
  name: string
  baseURL: string
  checkUrl: string
  parseModels: (data: unknown) => string[]
}[] = [
  {
    providerId: 'ollama',
    name: 'Ollama',
    baseURL: 'http://localhost:11434/v1',
    checkUrl: 'http://localhost:11434/api/tags',
    parseModels: (data: unknown) => {
      const body = data as { models?: { name: string }[] }
      if (!body?.models) return []
      return body.models.map((m) => m.name.replace(/:latest$/, ''))
    },
  },
  {
    providerId: 'lmstudio',
    name: 'LM Studio',
    baseURL: 'http://localhost:1234/v1',
    checkUrl: 'http://localhost:1234/v1/models',
    parseModels: (data: unknown) => {
      const body = data as { data?: { id: string }[] }
      if (!body?.data) return []
      return body.data.map((m) => m.id)
    },
  },
]

export async function detectLocal(): Promise<DetectResult[]> {
  const results: DetectResult[] = []

  for (const detector of DETECTORS) {
    try {
      const res = await fetch(detector.checkUrl, { signal: AbortSignal.timeout(3_000) })
      if (!res.ok) {
        results.push({
          providerId: detector.providerId,
          name: detector.name,
          baseURL: detector.baseURL,
          detected: false,
          models: [],
        })
        continue
      }
      const data = await res.json()
      const models = detector.parseModels(data)
      results.push({
        providerId: detector.providerId,
        name: detector.name,
        baseURL: detector.baseURL,
        detected: true,
        models,
      })
    } catch (err) {
      results.push({
        providerId: detector.providerId,
        name: detector.name,
        baseURL: detector.baseURL,
        detected: false,
        models: [],
        error: (err as Error).message,
      })
    }
  }

  return results
}
