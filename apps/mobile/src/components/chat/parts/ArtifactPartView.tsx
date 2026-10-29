/**
 * Artefato HTML da resposta (tool create_artifact / update_artifact).
 *
 * Antes esta part virava um cartão dizendo "disponível apenas no app desktop".
 * Agora o desktop serve o arquivo por HTTP (escopo `artifact`, token no
 * caminho) e a página interativa abre de verdade — o mesmo WebView que o
 * documento usa, e que motion/design/slides vão usar depois.
 *
 * `revision` entra como chave do host: o artefato é reescrito no MESMO arquivo,
 * então sem ela um `update_artifact` continuaria mostrando a versão anterior.
 */
import type { ArtifactPart } from '@orbit/shared'
import { useTranslation } from 'react-i18next'

import { PieceView } from '../PieceView'

export function ArtifactPartView({ part }: { part: ArtifactPart }) {
  const { t } = useTranslation()

  return (
    <PieceView
      src={part.src}
      title={part.title}
      poster={part.thumb}
      revision={part.revision}
      height={320}
      emptyLabel={t('parts.artifact.empty')}
      loadingLabel={t('parts.artifact.loading')}
      errorLabel={t('parts.artifact.error')}
    />
  )
}
