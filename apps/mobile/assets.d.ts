/**
 * Assets que não são imagem não têm tipo para o TypeScript: o Metro os registra
 * e `require`/`import` devolve o id numérico, que o `expo-asset` transforma em
 * arquivo. Sem esta declaração o import do bundle do mermaid não compila.
 */
declare module '*.txt' {
  const asset: number
  export default asset
}
