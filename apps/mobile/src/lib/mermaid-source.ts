/**
 * O bundle do mermaid, servido do próprio app.
 *
 * O diagrama é desenhado dentro de um WebView, que não enxerga o bundle JS do
 * React Native — alguma cópia da lib precisa chegar lá. Buscar de CDN deixaria
 * o desenho dependente de internet, e este app não deveria exigir internet: ele
 * fala com o desktop na LAN. Por isso o bundle vem vendorizado em
 * `assets/mermaid/mermaid.min.txt` (mermaid@11.17.2).
 *
 * A extensão `.txt` não é capricho: `js` é extensão de código para o Metro, e
 * um `.js` de 3,4 MB seria transpilado e embarcado no bundle principal, pago no
 * start de todo mundo. Registrado como asset (`metro.config.js`), ele é apenas
 * copiado para o pacote e lido quando um diagrama aparece.
 *
 * Para atualizar a versão:
 *   cp node_modules/mermaid/dist/mermaid.min.js \
 *      apps/mobile/assets/mermaid/mermaid.min.txt
 */
import { Asset } from 'expo-asset'
import * as FileSystem from 'expo-file-system/legacy'

import mermaidAsset from '../../assets/mermaid/mermaid.min.txt'

let pending: Promise<string | null> | null = null

/**
 * O código da lib, ou `null` quando o asset não pôde ser lido — e aí o chamador
 * cai no código-fonte do diagrama. Lido uma vez por sessão: são 3,4 MB, e o
 * mesmo texto serve para todos os diagramas.
 */
export function loadMermaidSource(): Promise<string | null> {
  pending ??= readAsset()
  return pending
}

async function readAsset(): Promise<string | null> {
  try {
    const asset = Asset.fromModule(mermaidAsset)
    // Em dev o asset é servido pelo Metro; `downloadAsync` copia para o cache e
    // preenche `localUri`. Em build de produção ele já está no pacote.
    if (!asset.localUri) await asset.downloadAsync()
    if (!asset.localUri) return null
    return await FileSystem.readAsStringAsync(asset.localUri)
  } catch {
    return null
  }
}
