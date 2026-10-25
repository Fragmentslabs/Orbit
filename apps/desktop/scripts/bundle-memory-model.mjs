/**
 * Prepara o modelo de embedding para ir DENTRO do app.
 *
 *   npm run memory:bundle
 *
 * Leva `onnx/model.onnx` + `tokenizer.bin` para `resources/memory-embed/<id>`,
 * que o electron-builder empacota em `extraResources` (`memory-embed` no
 * `process.resourcesPath`). O app carrega o modelo do próprio bundle e nunca
 * baixa nada — nem na instalação, nem depois de uma atualização.
 *
 * O `.json` de 34 MB fica de fora: o runtime lê o `.bin` compilado, que é 9 MB.
 * Mandar o `.json` obrigaria o worker a compilar dentro do bundle assinado, o
 * que invalida a assinatura do app no macOS.
 *
 * Falha de propósito quando não acha o modelo: um build sem ele instalaria um
 * Orbit sem busca semântica, e isso não pode passar em silêncio.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { compileTokenizer } from '../electron/memory-embed/tokenizer.mjs'

const ID = 'bekko-a8m'
const FILES = [path.join('onnx', 'model.onnx'), 'tokenizer.bin']

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.join(here, '..')
const dest = path.join(appRoot, 'resources', 'memory-embed', ID)
const force = process.argv.includes('--force')

const userData =
  process.platform === 'darwin'
    ? path.join(homedir(), 'Library', 'Application Support', '@orbit/desktop')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? homedir(), 'Orbit')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'orbit')

/** De onde copiar: cache de desenvolvimento primeiro, depois uma instalação do app. */
const sources = [
  path.join(appRoot, '.cache', 'memory-embed', ID),
  path.join(userData, 'memory', 'models', ID),
]

const hasGraph = (dir) => fs.existsSync(path.join(dir, 'onnx', 'model.onnx'))
const source = sources.find(hasGraph)

if (!source) {
  console.error(`\n✗ modelo ${ID} não encontrado.`)
  console.error('  Rode `npm run memory:model -- --dev` para baixá-lo (130 MB, uma vez).')
  console.error(`  Procurei em:\n${sources.map((s) => `    ${s}`).join('\n')}\n`)
  process.exit(1)
}

// O tokenizador de origem é obrigatório para gerar o `.bin` quando ele ainda
// não existe (primeira vez depois de um download limpo).
const json = path.join(source, 'tokenizer.json')
const bin = path.join(source, 'tokenizer.bin')
if (!fs.existsSync(bin)) {
  if (!fs.existsSync(json)) {
    console.error(`\n✗ nem tokenizer.bin nem tokenizer.json em ${source}\n`)
    process.exit(1)
  }
  console.log('… compilando tokenizer.json → tokenizer.bin (só nesta máquina, uma vez)')
  compileTokenizer(json, bin)
}

console.log(`modelo ${ID}`)
console.log(`  de   ${source}`)
console.log(`  para ${dest}`)

let total = 0
for (const file of FILES) {
  const from = path.join(source, file)
  const to = path.join(dest, file)
  if (!fs.existsSync(from)) {
    console.error(`\n✗ ${file} ausente em ${source}\n`)
    process.exit(1)
  }
  const size = fs.statSync(from).size
  total += size
  // Bytes iguais entre builds é o que faz a atualização ser diferencial: se o
  // destino já tem o mesmo tamanho, não se toca nele (nem no mtime).
  if (!force && fs.existsSync(to) && fs.statSync(to).size === size) {
    console.log(`  = ${file} (${(size / 1e6).toFixed(1)} MB, já está)`)
    continue
  }
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  console.log(`  + ${file} (${(size / 1e6).toFixed(1)} MB)`)
}

console.log(`pronto: ${(total / 1e6).toFixed(0)} MB vão dentro do app.`)
