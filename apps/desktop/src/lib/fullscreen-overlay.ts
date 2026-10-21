/**
 * Padrão de "tela cheia" das abas do painel (Browser, Motion, Design e a
 * apresentação do Design).
 *
 * Não é a tela cheia da JANELA: a barra do app (`Titlebar`, `h-8`, com o menu e
 * os botões de minimizar/maximizar/fechar) continua onde está, e a aba só
 * cresce para ocupar o resto da área — o cabeçalho dela fica ABAIXO da barra,
 * nunca no lugar dela. Cobrir a barra impedia de fechar o app e deixava parte
 * dos botões sem resposta (a região de arrastar da janela engole o clique por
 * baixo de qualquer sobreposição).
 *
 * Todo overlay de tela cheia usa estas classes — é o que mantém o `top-8`
 * igual à altura do Titlebar num lugar só. Se a altura da barra mudar, muda
 * aqui (e no `h-8` do titlebar.tsx).
 */

/** Altura do Titlebar em px (`h-8`) — para quem precisa do número, não da classe. */
export const TITLEBAR_HEIGHT_PX = 32

/** Classes do elemento raiz de uma aba enquanto ela está em tela cheia. */
export const FULLSCREEN_OVERLAY_CLASS = "fixed inset-x-0 bottom-0 top-8 z-[60] h-auto w-auto rounded-none border-0"
