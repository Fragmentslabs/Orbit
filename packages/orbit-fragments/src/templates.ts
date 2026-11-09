import apiPackage from '../../orbit-fragments-api/package.json'
import { FRAGMENT_SDK_VERSION } from '@orbit/shared/fragment-rules'
import type { FragmentKind } from '@orbit/shared/fragments'

/** The files `orbit-fragments init` writes, relative to the new fragment's folder. */
export function scaffoldFiles(options: { name: string; kind: FragmentKind; slug: string }): Record<string, string> {
  const manifest = {
    name: options.name,
    icon: 'sparkles',
    kind: options.kind,
    sdk: FRAGMENT_SDK_VERSION,
    requests: [],
  }
  const project = {
    name: options.slug,
    private: true,
    description: `${options.name}, an Orbit fragment`,
    scripts: { validate: 'orbit-fragments validate' },
    devDependencies: { 'orbit-fragments-api': `^${apiPackage.version}` },
  }
  const jsconfig = {
    compilerOptions: { checkJs: true, noEmit: true, target: 'ES2022', module: 'ESNext', types: ['orbit-fragments-api'] },
    include: ['src'],
  }
  return {
    'manifest.json': json(manifest),
    'package.json': json(project),
    'jsconfig.json': json(jsconfig),
    'src/index.html': indexHtml(options.name),
    'src/app.js': APP_JS,
    'src/style.css': STYLE_CSS,
  }
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function indexHtml(name: string): string {
  const title = escapeHtml(name)
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      <p>You have clicked <strong id="count">0</strong> times. The number survives closing Orbit.</p>
      <button id="click" type="button">Click me</button>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`
}

const APP_JS = `// @ts-check
/// <reference types="orbit-fragments-api" />

// \`orbit\` is injected by the app. Its calls are answered by Orbit, never by the network.
const countEl = document.getElementById('count')
const button = document.getElementById('click')

/** @type {number} */
let count = 0

function render() {
  if (countEl) countEl.textContent = String(count)
}

async function load() {
  count = (await orbit.store.get('count')) ?? 0
  render()
}

button?.addEventListener('click', async () => {
  count += 1
  render()
  await orbit.store.set('count', count)
})

load().catch((error) => console.error(error))
`

const STYLE_CSS = `/* Orbit injects its design tokens (colors, fonts) and follows the light/dark theme. */
body {
  margin: 0;
  font-family: var(--font-sans, system-ui, sans-serif);
  color: var(--foreground, inherit);
  background: var(--background, transparent);
}

main {
  display: grid;
  gap: 12px;
  padding: 24px;
  max-width: 480px;
}

button {
  justify-self: start;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border, #8884);
  background: var(--card, transparent);
  color: inherit;
  cursor: pointer;
}
`
