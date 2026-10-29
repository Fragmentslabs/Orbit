/**
 * Re-export do contrato dos blocos `orbit-ui`, que agora mora no shared para o
 * app mobile desenhar os mesmos componentes (o schema é o mesmo nos dois).
 *
 * O arquivo fica aqui para não mexer nos importadores (`@/src/lib/orbit-ui`):
 * o caminho público do desktop continua o mesmo.
 */
export * from "@shared/orbit-ui"
