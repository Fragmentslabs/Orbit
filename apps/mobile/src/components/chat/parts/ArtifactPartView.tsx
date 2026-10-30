/**
 * HTML artifact of the answer (tool create_artifact / update_artifact).
 *
 * Before, this part became a card saying "available only in the desktop app".
 * Now the desktop serves the file over HTTP (scope `artifact`, token in the
 * path) and the interactive page really opens — the same WebView the
 * document uses, and which motion/design/slides will use later.
 *
 * `revision` comes in as the host key: the artifact is rewritten into the SAME file,
 * so without it an `update_artifact` would keep showing the previous version.
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
