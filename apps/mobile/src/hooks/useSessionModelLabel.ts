import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '~/stores/settings-store'
import { useSessionModel } from '~/stores/session-store'
import { useSessionRotation } from '~/stores/model-rotation-store'

/**
 * Name of the model of the conversation (per-chat override > last chat > global
 * default), with the pinned rotation winning — the same resolution as the trigger of
 * the picker, which used to live in the input. Now the name is read in the header and
 * in the "Model" row of the sheet.
 */
export function useSessionModelLabel(sessionId?: string | null): string {
  const { t } = useTranslation()
  const catalog = useSettingsStore((s) => s.catalog)
  const selected = useSessionModel(sessionId)
  const rotation = useSessionRotation(sessionId)

  if (rotation?.name) return rotation.name
  if (!selected) return t('modelPicker.select')
  const info = catalog?.[selected.providerId]?.models[selected.modelId]
  return info?.name ?? selected.modelId
}
