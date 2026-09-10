module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    // Desligada de propósito: é uma dica de granularidade do Fast Refresh
    // (dev), sem efeito em produção, e o repositório viola a premissa dela por
    // decisão de arquitetura — provider e seu hook no mesmo arquivo
    // (theme-provider/useTheme, workspace-context/useWorkspace) e componentes
    // do shadcn junto de suas variants (button/buttonVariants). Cumpri-la
    // exigiria quebrar 19 arquivos em dois, incluindo os vendorizados do
    // shadcn e do ai-elements, que assim divergiriam do upstream.
    'react-refresh/only-export-components': 'off',
    // Prefixo "_" e rest siblings marcam descarte DELIBERADO — o caso comum
    // é desestruturar uma prop só para ela não vazar no {...props} de um
    // elemento do DOM (React avisa em atributo desconhecido).
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
}
