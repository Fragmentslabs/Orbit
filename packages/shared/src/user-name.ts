/**
 * Teto do nome guardado. app-settings.ts importa daqui para os dois não divergirem.
 *
 * Não existe detecção automática por texto: reconhecer "meu nome é X" exigiria
 * fixar frases de um idioma, e o Orbit é usado em qualquer um. Quem lê o nome é
 * o MODELO, pela tool `set_user_name` — que entende a frase em qualquer idioma,
 * inclusive uma correção ("não, é Rafa") ou um pedido para esquecer.
 */
export const USER_NAME_MAX = 40
