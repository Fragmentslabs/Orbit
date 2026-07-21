import tailwindcss from '@tailwindcss/postcss'

export default {
  plugins: [
    tailwindcss(),
    {
      postcssPlugin: 'remove-property-atrules',
      AtRule: {
        property: (atRule) => {
          atRule.remove()
        },
      },
    },
  ],
}
