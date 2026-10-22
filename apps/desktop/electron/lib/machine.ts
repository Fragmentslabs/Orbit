import os from 'node:os'

/**
 * Capacidade da máquina, num lugar só.
 *
 * A detecção nasceu dentro da voz (`voice/hardware.ts`), que decidia o motor de
 * transcrição contando RAM. Ela é útil para qualquer recurso que precise
 * responder "dá para ir no máximo?" — hoje o perfil de gravação do
 * `browser_record`, amanhã o render de motion.
 *
 * O que importa aqui é o que pesa no trabalho de mídia: núcleos (compositor +
 * x264) e RAM (fila de quadros). A pontuação é grosseira DE PROPÓSITO — não é
 * benchmark, é um degrau. Medir de verdade (rodar uma amostra e cronometrar)
 * custaria segundos a cada chamada e daria respostas diferentes conforme o que
 * estivesse aberto na máquina.
 *
 * Regra de ouro para quem consome: o tier é uma SUGESTÃO de padrão. Um pedido
 * explícito do usuário (ou do agente) sempre vence — máquina fraca não impede
 * gravar em qualidade alta, só avisa que pode faltar fôlego.
 */

export type MachineTier = 'weak' | 'balanced' | 'strong'

export interface MachineInfo {
  platform: string
  arch: string
  cpus: number
  totalMemGb: number
  /** Pontuação crua — só para diagnóstico; quem decide é `tier`. */
  score: number
  tier: MachineTier
}

/** A partir daqui a máquina aguenta 60 fps em resolução alta sem engasgar. */
const STRONG_SCORE = 9

/** Abaixo disto sobra pouco para capturar e codificar ao mesmo tempo. */
const BALANCED_SCORE = 3

export function machineTier(score: number): MachineTier {
  if (score >= STRONG_SCORE) return 'strong'
  if (score >= BALANCED_SCORE) return 'balanced'
  return 'weak'
}

/**
 * - núcleos: cada núcleo acima de 4 vale 1 (os 4 primeiros são o mínimo para o
 *   app rodar; o que sobra é o que o compositor e o x264 podem usar);
 * - RAM: 8 GB = 1, 16 GB = 3, 32 GB+ = 5 (é onde a fila de quadros mora);
 * - Apple Silicon: +3, porque o encode tem o VideoToolbox ao lado e o
 *   compositor é bem mais eficiente que o de um x64 da mesma faixa.
 *
 * As faixas de RAM são 7/12/30 e não 8/16/32 de propósito: o `os.totalmem()`
 * desconta o que o firmware e a GPU integrada reservam, então uma máquina de
 * 16 GB se apresenta com ~15,3 GB. Com o corte em 16, ela cairia no degrau de
 * baixo — exatamente quem tem folga de sobra. (Mesma armadilha que a voz já
 * documenta em `MIN_MEMORY_GB`.)
 */
export function scoreMachine(input: {
  cpus: number
  totalMemGb: number
  platform: string
  arch: string
}): number {
  const cores = Math.max(0, input.cpus - 4)
  const ram = input.totalMemGb >= 30 ? 5 : input.totalMemGb >= 12 ? 3 : input.totalMemGb >= 7 ? 1 : 0
  const apple = input.platform === 'darwin' && input.arch === 'arm64' ? 3 : 0
  return cores + ram + apple
}

export function detectMachine(): MachineInfo {
  const platform = process.platform
  const arch = os.arch()
  const cpus = Math.max(1, os.cpus().length || 1)
  // Mesma conta da voz: o `totalmem()` desconta o que o firmware reserva, e uma
  // máquina de 16 GB aparece com ~15,3 GB.
  const totalMemGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const score = scoreMachine({ cpus, totalMemGb, platform, arch })
  return { platform, arch, cpus, totalMemGb, score, tier: machineTier(score) }
}
