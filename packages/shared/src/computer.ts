/**
 * Computer Use: o que o main conta ao renderer sobre o controle do computador
 * (chip no header, painel das Preferências).
 */

/** Uma sessão de chat que está controlando (ou acabou de controlar) um app. */
export interface ComputerActivity {
  sessionId: string
  /** Nome do app alvo da última ação */
  app: string
  /** Início do controle contínuo (ms) */
  startedAt: number
  /** Última ação/observação (ms) */
  lastAt: number
  /** Última ação, legível ("click em Salvar") */
  lastAction: string | null
}

export type ComputerEvent =
  | { type: "active"; activity: ComputerActivity }
  | { type: "idle"; sessionId: string }

/** Estado da capacidade nesta máquina (Preferências → Computador). */
export interface ComputerStatus {
  /** A plataforma tem driver e o build não é da Mac App Store */
  available: boolean
  /** Motivo quando indisponível: "mas", "platform" */
  reason: "mas" | "platform" | null
  platform: string
  /** Acessibilidade concedida ao Orbit */
  accessibility: boolean
  /** Gravação de Tela: "granted" | "denied" | "not-determined" | "restricted" | "unknown" */
  screen: string
  /** Em dev a permissão é do binário do Electron, não do Orbit */
  dev: boolean
  /**
   * App que o macOS considera dono das permissões, quando não é o próprio
   * Orbit: em dev, quem rodou `npm run dev` (Terminal, iTerm, VS Code…). null =
   * o próprio app.
   */
  responsible: string | null
}

/** Resultado do botão "Testar" (uma chamada real à bridge). */
export interface ComputerTestResult {
  ok: boolean
  /** Tempo da lista de apps + árvore do app da frente */
  ms: number
  message: string
}
